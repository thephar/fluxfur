// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {Logger} from '@app/api/Logger';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {HostedOnlyRoute} from '@app/api/middleware/BillingRouteAvailability';
import {CaptchaMiddleware, createCaptchaChallenge} from '@app/api/middleware/CaptchaMiddleware';
import {
	getTrustedForwardedClientIp,
	RateLimitMiddleware,
	shouldEnforceRateLimits,
} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {getOperatorPassEntitlementService, getOperatorPassWallService} from '@app/api/middleware/ServiceSingletons';
import type {OperatorPassCheckoutService} from '@app/api/operator_pass/OperatorPassCheckoutService';
import {
	isOperatorPassRemovalActive,
	resolveOperatorPassHolder,
} from '@app/api/operator_pass/OperatorPassEntitlementService';
import type {OperatorPassFulfilmentService} from '@app/api/operator_pass/OperatorPassFulfilmentService';
import {mapOperatorPassPurchaseToResponse} from '@app/api/operator_pass/OperatorPassPurchaseRules';
import {operatorPassNow} from '@app/api/operator_pass/OperatorPassSchedule';
import type {OperatorPassWaitlistService} from '@app/api/operator_pass/OperatorPassWaitlistService';
import {
	mapOperatorPassListing,
	normalizeOperatorPassWallChoice,
} from '@app/api/operator_pass/OperatorPassWallPresentation';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import {OperatorPassRateLimitConfigs} from '@app/api/rate_limit_configs/OperatorPassRateLimitConfig';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {lookupGeoip} from '@app/api/utils/IpUtils';
import {getRequestClientIp} from '@app/api/utils/RequestClientIp';
import {Validator} from '@app/api/Validator';
import {OperatorPassNotHeldError} from '@fluxer/errors/src/domains/operator_pass/OperatorPassNotHeldError';
import {OperatorPassWaitlistTokenInvalidError} from '@fluxer/errors/src/domains/operator_pass/OperatorPassWaitlistTokenInvalidError';
import {StripePaymentNotAvailableError} from '@fluxer/errors/src/domains/payment/StripePaymentNotAvailableError';
import {
	OperatorPassCheckoutRequest,
	OperatorPassCheckoutResponse,
	OperatorPassLatestReleaseResponse,
	OperatorPassListingResponse,
	OperatorPassListingUpdateRequest,
	OperatorPassOfferAcceptRequest,
	OperatorPassOfferCreateRequest,
	OperatorPassOfferIdParam,
	OperatorPassOfferResponse,
	OperatorPassPassesResponse,
	OperatorPassPassIdParam,
	OperatorPassPurchaseIdParam,
	OperatorPassPurchaseListResponse,
	OperatorPassPurchaseResponse,
	OperatorPassStateQuery,
	OperatorPassStateResponse,
	OperatorPassWaitlistChallengeResponse,
	OperatorPassWaitlistConfirmRequest,
	OperatorPassWaitlistConfirmResponse,
	OperatorPassWaitlistFollowupRequest,
	OperatorPassWaitlistRequest,
	OperatorPassWaitlistResponse,
	OperatorPassWaitlistUnsubscribeQuery,
	OperatorPassWaitlistUnsubscribeRequest,
	OperatorPassWaitlistUnsubscribeResponse,
	OperatorPassWallResponse,
	OperatorPassWithdrawRequest,
} from '@fluxer/schema/src/domains/operator_pass/OperatorPassSchemas';
import type {Context} from 'hono';

const TAG = 'Operator Pass';

function requireOperatorPassCheckoutService(ctx: Context<HonoEnv>): OperatorPassCheckoutService {
	const service = ctx.get('operatorPassCheckoutService');
	if (!service) {
		throw new StripePaymentNotAvailableError();
	}
	return service;
}

function requireFulfilmentService(ctx: Context<HonoEnv>): OperatorPassFulfilmentService {
	const service = ctx.get('stripeService').operatorPassFulfilment;
	if (!service) {
		throw new StripePaymentNotAvailableError();
	}
	return service;
}

function requireWaitlistService(ctx: Context<HonoEnv>): OperatorPassWaitlistService {
	const service = ctx.get('operatorPassWaitlistService');
	if (!service) {
		throw new Error('Operator Pass waitlist service is not available');
	}
	return service;
}

async function lookupCountryCode(ip: string | null): Promise<string | null> {
	if (!ip) return null;
	try {
		return (await lookupGeoip(ip)).countryCode;
	} catch (error) {
		Logger.warn({error}, 'Operator Pass waitlist GeoIP lookup failed');
		return null;
	}
}

async function readUnsubscribeBodyToken(ctx: Context<HonoEnv>): Promise<string | null> {
	const text = await ctx.req.text();
	if (text.trim().length === 0) return null;
	const contentType = ctx.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (contentType === 'application/x-www-form-urlencoded') {
		return parseUnsubscribeToken(new URLSearchParams(text).get('token'));
	}
	if (contentType === 'application/json') {
		try {
			const parsed = OperatorPassWaitlistUnsubscribeRequest.safeParse(JSON.parse(text));
			return parsed.success ? (parsed.data.token ?? null) : null;
		} catch {
			return null;
		}
	}
	return null;
}

function parseUnsubscribeToken(value: string | null): string | null {
	const parsed = OperatorPassWaitlistUnsubscribeRequest.shape.token.safeParse(value ?? undefined);
	return parsed.success ? (parsed.data ?? null) : null;
}

export function OperatorPassController(app: HonoApp) {
	app.get(
		'/operator-pass/state',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_STATE),
		OpenAPI({
			operationId: 'get_operator_pass_state',
			summary: 'Get Operator Pass state',
			description:
				'Returns the sale phase, the price of one pass in the buyer currency, the most passes one checkout can buy, the withdrawal rule of the buyer country and a signed quote. Signed-in callers also get their holder status with the number of passes they hold, and why they cannot buy passes.',
			responseSchema: OperatorPassStateResponse,
			statusCode: 200,
			security: [],
			tags: TAG,
		}),
		Validator('query', OperatorPassStateQuery),
		async (ctx) => {
			const {country_code: countryCode} = ctx.req.valid('query');
			const sessionUser = ctx.get('authTokenType') === 'session' ? (ctx.get('user') ?? null) : null;
			const user = sessionUser && !sessionUser.isBot ? sessionUser : null;
			const geoipCountryCode = user || !countryCode ? ((await lookupGeoip(ctx.req.raw)).countryCode ?? null) : null;
			const state = await requireOperatorPassCheckoutService(ctx).getState({
				user,
				countryCode: user ? (geoipCountryCode ?? countryCode ?? null) : (countryCode ?? geoipCountryCode),
			});
			return ctx.json(state);
		},
	);
	app.post(
		'/operator-pass/checkout',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_CHECKOUT),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'create_operator_pass_checkout',
			summary: 'Create Operator Pass checkout session',
			description:
				'Creates a Stripe checkout session for one or more Operator Passes with an optional monthly donation. Every pass is delivered to the current account as soon as the payment settles. Buying more passes while holding some adds to the count.',
			responseSchema: OperatorPassCheckoutResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('json', OperatorPassCheckoutRequest),
		async (ctx) => {
			const url = await requireOperatorPassCheckoutService(ctx).createCheckoutSession({
				user: ctx.get('user'),
				request: ctx.req.valid('json'),
				geoipCountryCode: (await lookupGeoip(ctx.req.raw)).countryCode ?? null,
				clientIp: getRequestClientIp(ctx),
				userAgent: ctx.req.header('user-agent') ?? null,
			});
			return ctx.json({url});
		},
	);
	app.get(
		'/operator-pass/purchases',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_PURCHASES),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'list_operator_pass_purchases',
			summary: 'List Operator Pass purchases',
			description:
				'Lists the Operator Pass purchases the current account paid for, with the quantity, the delivery time and whether the withdraw button for the whole purchase is available.',
			responseSchema: OperatorPassPurchaseListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		async (ctx) => {
			const service = requireFulfilmentService(ctx);
			const purchases = await service.listPurchases(ctx.get('user').id);
			const now = operatorPassNow();
			return ctx.json(
				await Promise.all(
					purchases.map(async (purchase) =>
						mapOperatorPassPurchaseToResponse(
							purchase,
							await service.repository.listUnitsByPurchase(purchase.checkout_session_id),
							now,
						),
					),
				),
			);
		},
	);
	app.post(
		'/operator-pass/purchases/:purchase_id/withdraw',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WITHDRAW),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'withdraw_operator_pass_purchase',
			summary: 'Withdraw from an Operator Pass purchase',
			description:
				'Withdraws from a paid Operator Pass purchase whose passes are not delivered yet. Refunds the passes in full to the original payment method and emails a timestamped receipt to the account email. A monthly donation added at checkout keeps running. Delivered passes in a withdrawal_rule country are withdrawn one by one with the pass withdraw route.',
			responseSchema: OperatorPassPurchaseResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('param', OperatorPassPurchaseIdParam),
		Validator('json', OperatorPassWithdrawRequest),
		async (ctx) => {
			const {name} = ctx.req.valid('json');
			const service = requireFulfilmentService(ctx);
			const purchase = await service.withdraw({
				purchaser: ctx.get('user'),
				purchaseId: ctx.req.valid('param').purchase_id,
				name,
				channel: 'button',
				receivedAt: operatorPassNow(),
			});
			return ctx.json(
				mapOperatorPassPurchaseToResponse(
					purchase,
					await service.repository.listUnitsByPurchase(purchase.checkout_session_id),
					operatorPassNow(),
				),
			);
		},
	);
	app.get(
		'/operator-pass/waitlist/challenge',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WAITLIST_CHALLENGE),
		OpenAPI({
			operationId: 'get_operator_pass_waitlist_challenge',
			summary: 'Get Operator Pass waitlist captcha challenge',
			description: 'Returns the captcha challenge to solve before joining the Operator Pass waitlist.',
			responseSchema: OperatorPassWaitlistChallengeResponse,
			statusCode: 200,
			security: [],
			tags: TAG,
		}),
		async (ctx) => {
			ctx.header('Cache-Control', 'no-store');
			return ctx.json(await createCaptchaChallenge(ctx), 200);
		},
	);
	app.post(
		'/operator-pass/waitlist',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WAITLIST),
		CaptchaMiddleware,
		OpenAPI({
			operationId: 'join_operator_pass_waitlist',
			summary: 'Join Operator Pass waitlist',
			description:
				'Sends a confirmation email to the address and stores how the visitor feels about the early bird price they were shown. The response is the same whether or not the address is already on the waitlist, and always carries a followup_token for the follow-up question. Addresses are matched without plus tags, and Gmail addresses without dots. A later signup by the same pending address replaces the stored answer, a confirmed address keeps its first answer, a bounced address gets no email and an unsubscribed address gets at most one new confirmation email every 30 days. Requires a solved captcha challenge (X-Captcha-Token).',
			responseSchema: OperatorPassWaitlistResponse,
			statusCode: 202,
			security: [],
			tags: TAG,
		}),
		Validator('json', OperatorPassWaitlistRequest),
		async (ctx) => {
			const {email, country_code, price_feedback, currency} = ctx.req.valid('json');
			const consentIp =
				getTrustedForwardedClientIp(ctx, OperatorPassRateLimitConfigs.OPERATOR_PASS_WAITLIST.bucket) ??
				getRequestClientIp(ctx);
			const {followupToken} = await requireWaitlistService(ctx).join({
				email,
				meterRateLimits: shouldEnforceRateLimits(ctx),
				countryCode: country_code ?? (await lookupCountryCode(consentIp)),
				locale: ctx.get('requestLocale') ?? null,
				consentIp,
				priceFeedback: price_feedback,
				currency,
			});
			ctx.header('Cache-Control', 'no-store');
			return ctx.json({status: 'pending' as const, followup_token: followupToken}, 202);
		},
	);
	app.post(
		'/operator-pass/waitlist/followup',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WAITLIST_FOLLOWUP),
		OpenAPI({
			operationId: 'answer_operator_pass_waitlist_followup',
			summary: 'Answer Operator Pass waitlist follow-up question',
			description:
				'Stores what is most important to the visitor about the Operator Pass and which descriptions fit them, with the followup_token from the waitlist signup response. A new answer replaces the stored one while the token is valid, for 30 minutes after the signup. An answer without about keeps the descriptions stored before. A token from a signup whose address was already on the waitlist is accepted and stores nothing, so the response never shows whether an address is on the waitlist. other_text is plain text and only goes with other in picks.',
			responseSchema: null,
			statusCode: 204,
			security: [],
			tags: TAG,
		}),
		Validator('json', OperatorPassWaitlistFollowupRequest),
		async (ctx) => {
			const {token, picks, about, other_text} = ctx.req.valid('json');
			await requireWaitlistService(ctx).answerFollowup({
				token,
				picks,
				about,
				otherText: other_text,
				meterRateLimits: shouldEnforceRateLimits(ctx),
			});
			return ctx.body(null, 204);
		},
	);
	app.post(
		'/operator-pass/waitlist/confirm',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WAITLIST_CONFIRM),
		OpenAPI({
			operationId: 'confirm_operator_pass_waitlist',
			summary: 'Confirm Operator Pass waitlist email',
			description: 'Confirms a waitlist email address with the token from the confirmation email.',
			responseSchema: OperatorPassWaitlistConfirmResponse,
			statusCode: 200,
			security: [],
			tags: TAG,
		}),
		Validator('json', OperatorPassWaitlistConfirmRequest),
		async (ctx) => {
			await requireWaitlistService(ctx).confirm(ctx.req.valid('json').token);
			return ctx.json({status: 'confirmed' as const}, 200);
		},
	);
	app.get(
		'/operator-pass/waitlist/unsubscribe',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WAITLIST_UNSUBSCRIBE),
		OpenAPI({
			operationId: 'open_operator_pass_waitlist_unsubscribe',
			summary: 'Open Operator Pass waitlist unsubscribe page',
			description:
				'Redirects a mail client that opens the unsubscribe link to the page where the address can leave the waitlist. Nothing changes until that page is submitted.',
			responseSchema: null,
			statusCode: 302,
			security: [],
			tags: TAG,
		}),
		Validator('query', OperatorPassWaitlistUnsubscribeQuery),
		(ctx) => {
			const {token} = ctx.req.valid('query');
			const query = token ? `?token=${encodeURIComponent(token)}` : '';
			return ctx.redirect(`${Config.endpoints.marketing}/pass/unsubscribe${query}`, 302);
		},
	);
	app.post(
		'/operator-pass/waitlist/unsubscribe',
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WAITLIST_UNSUBSCRIBE),
		OpenAPI({
			operationId: 'unsubscribe_operator_pass_waitlist',
			summary: 'Leave Operator Pass waitlist',
			description:
				'Removes an address from the waitlist with the token from a waitlist email. Supports one-click unsubscribe from mail clients.',
			responseSchema: OperatorPassWaitlistUnsubscribeResponse,
			statusCode: 200,
			security: [],
			tags: TAG,
		}),
		Validator('query', OperatorPassWaitlistUnsubscribeQuery),
		async (ctx) => {
			const token = ctx.req.valid('query').token ?? (await readUnsubscribeBodyToken(ctx));
			if (!token) {
				throw new OperatorPassWaitlistTokenInvalidError();
			}
			await requireWaitlistService(ctx).unsubscribe(token);
			return ctx.json({status: 'unsubscribed' as const}, 200);
		},
	);
	app.get(
		'/operator-pass/listing',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_LISTING),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'get_operator_pass_listing',
			summary: "Get Operators' wall listing",
			description:
				"Returns what the Operators' wall shows for the current account right now, the name it submitted, the review state, why staff declined a name or avatar, and how many passes the account holds. The review state and the reason are only for the holder, the public wall never shows them.",
			responseSchema: OperatorPassListingResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		async (ctx) => {
			const user = ctx.get('user');
			const entitlement = getOperatorPassEntitlementService();
			const [entry, state] = await Promise.all([
				getOperatorPassWallService().getEntry(user.id),
				entitlement.loadState(user.id),
			]);
			const holder = resolveOperatorPassHolder(state);
			return ctx.json(
				mapOperatorPassListing(entry, holder?.count ?? 0, user, {removed: isOperatorPassRemovalActive(state.removal)}),
			);
		},
	);
	app.put(
		'/operator-pass/listing',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_LISTING),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'update_operator_pass_listing',
			summary: "Update Operators' wall listing",
			description:
				"Submits a new name for the Operators' wall, takes the listing off the wall, or sets keep_as_is or release_list_opt_in. A new name, together with the current profile avatar, waits for review and the wall keeps showing the last approved version, or the fallback, until staff approve it. A declined name can be replaced at any time. An already listed holder can send only keep_as_is or release_list_opt_in.",
			responseSchema: OperatorPassListingResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('json', OperatorPassListingUpdateRequest),
		async (ctx) => {
			const user = ctx.get('user');
			const holder = await getOperatorPassEntitlementService().getHolder(user);
			if (!holder) {
				throw new OperatorPassNotHeldError();
			}
			const body = ctx.req.valid('json');
			const wallService = getOperatorPassWallService();
			const current = await wallService.getEntry(user.id);
			const choice =
				!body.wall_opt_out && !body.wall_name && current && !current.opted_out
					? {name: null, optedOut: false}
					: normalizeOperatorPassWallChoice({name: body.wall_name, optOut: body.wall_opt_out});
			await wallService.setChoice(user.id, choice, user.id, {
				keepAsIs: body.keep_as_is,
				releaseListOptIn: body.release_list_opt_in,
			});
			return ctx.json(mapOperatorPassListing(await wallService.getEntry(user.id), holder.count, user));
		},
	);
	app.get(
		'/operator-pass/passes',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_PASSES),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'list_operator_passes',
			summary: 'List Operator Passes',
			description:
				'Returns how many passes the current account holds, each pass with whether it can be passed on or withdrawn, and the open Pass it on offers to and from the account. The count is returned even when the badge is hidden or the account chose not to be listed.',
			responseSchema: OperatorPassPassesResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		async (ctx) => {
			return ctx.json(await requireFulfilmentService(ctx).holdingService.queries.describePasses(ctx.get('user')));
		},
	);
	app.post(
		'/operator-pass/passes/:pass_id/offers',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_OFFER),
		RateLimitMiddleware(RateLimitConfigs.USER_FRIEND_REQUEST_SEND),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'create_operator_pass_offer',
			summary: 'Pass an Operator Pass on',
			description:
				'Offers a pass the current account bought to another user. The offer stays pending until the recipient accepts or declines, and the sender can withdraw it until then. Once accepted, the pass moves when the transfer lock ends, and only while the payment has no early fraud warning, open dispute or refund. Passing on the last pass needs confirm_last_pass, because it removes the badge and the wall listing.',
			responseSchema: OperatorPassOfferResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('param', OperatorPassPassIdParam),
		Validator('json', OperatorPassOfferCreateRequest),
		async (ctx) => {
			const user = ctx.get('user');
			const body = ctx.req.valid('json');
			const fulfilment = requireFulfilmentService(ctx);
			const offer = await fulfilment.createOffer({
				sender: user,
				passId: ctx.req.valid('param').pass_id,
				recipient:
					body.recipient_id != null
						? {id: createUserID(body.recipient_id)}
						: {username: body.username ?? '', discriminator: body.discriminator ?? -1},
				confirmLastPass: body.confirm_last_pass === true,
			});
			return ctx.json(await fulfilment.holdingService.queries.describeOffer(user, offer.offer_id));
		},
	);
	app.post(
		'/operator-pass/passes/:pass_id/withdraw',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WITHDRAW),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'withdraw_operator_pass',
			summary: 'Withdraw from an Operator Pass',
			description:
				'Withdraws one delivered pass bought in a country whose withdrawal right cannot be waived, within the days the rule gives. Refunds the price of that pass in full, ends the pass and emails a timestamped receipt to the account email.',
			responseSchema: OperatorPassPassesResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('param', OperatorPassPassIdParam),
		Validator('json', OperatorPassWithdrawRequest),
		async (ctx) => {
			const user = ctx.get('user');
			const service = requireFulfilmentService(ctx);
			await service.withdrawUnit({
				holder: user,
				passId: ctx.req.valid('param').pass_id,
				name: ctx.req.valid('json').name,
				receivedAt: operatorPassNow(),
			});
			return ctx.json(await service.holdingService.queries.describePasses(user));
		},
	);
	app.get(
		'/operator-pass/offers/:offer_id',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_PASSES),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'get_operator_pass_offer',
			summary: 'Get Pass it on offer',
			description: 'Returns a Pass it on offer the current account made or received.',
			responseSchema: OperatorPassOfferResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('param', OperatorPassOfferIdParam),
		async (ctx) => {
			return ctx.json(
				await requireFulfilmentService(ctx).holdingService.queries.describeOffer(
					ctx.get('user'),
					ctx.req.valid('param').offer_id,
				),
			);
		},
	);
	app.delete(
		'/operator-pass/offers/:offer_id',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_OFFER),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'withdraw_operator_pass_offer',
			summary: 'Withdraw Pass it on offer',
			description:
				'Withdraws an offer the current account made, while the pass has not moved yet. The pass stays with the sender and the recipient gets an email.',
			responseSchema: OperatorPassOfferResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('param', OperatorPassOfferIdParam),
		async (ctx) => {
			const user = ctx.get('user');
			const holding = requireFulfilmentService(ctx).holdingService;
			const offer = await holding.withdrawOffer(user, ctx.req.valid('param').offer_id);
			return ctx.json(await holding.queries.describeOffer(user, offer.offer_id));
		},
	);
	app.post(
		'/operator-pass/offers/:offer_id/accept',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_OFFER),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'accept_operator_pass_offer',
			summary: 'Accept Pass it on offer',
			description:
				"Accepts an offer to the current account with the Operator Pass terms and a choice for the Operators' wall. The pass moves at arrives_at, at once when the transfer lock has already ended. A received pass cannot be passed on again, and it ends if the payment for it is reversed.",
			responseSchema: OperatorPassOfferResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('param', OperatorPassOfferIdParam),
		Validator('json', OperatorPassOfferAcceptRequest),
		async (ctx) => {
			const user = ctx.get('user');
			const body = ctx.req.valid('json');
			const holding = requireFulfilmentService(ctx).holdingService;
			const choice =
				body.wall_opt_out == null && !body.wall_name
					? null
					: normalizeOperatorPassWallChoice({name: body.wall_name, optOut: body.wall_opt_out});
			const offer = await holding.acceptOffer({
				recipient: user,
				offerId: ctx.req.valid('param').offer_id,
				acceptedTerms: body.accept_terms,
				choice,
			});
			return ctx.json(await holding.queries.describeOffer(user, offer.offer_id));
		},
	);
	app.post(
		'/operator-pass/offers/:offer_id/decline',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_OFFER),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'decline_operator_pass_offer',
			summary: 'Decline Pass it on offer',
			description:
				'Declines a pending offer to the current account. The pass stays with the sender, who gets an email.',
			responseSchema: OperatorPassOfferResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: TAG,
		}),
		Validator('param', OperatorPassOfferIdParam),
		async (ctx) => {
			const user = ctx.get('user');
			const holding = requireFulfilmentService(ctx).holdingService;
			const offer = await holding.declineOffer(user, ctx.req.valid('param').offer_id);
			return ctx.json(await holding.queries.describeOffer(user, offer.offer_id));
		},
	);
	app.get(
		'/operator-pass/wall',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WALL),
		OpenAPI({
			operationId: 'get_operator_pass_wall',
			summary: "Get Operators' wall",
			description:
				"Lists every Operator on the Operators' wall with the name and avatar the wall shows, the time the listing went up, the time of the first pass, how many passes the Operator holds and the size tier, with the highest tier first and the earliest first pass first within a tier. A declined name or avatar shows as the last accepted version, or the username, or Operator, with the default avatar. Review states and reasons are never included. Holders who chose not to be listed and paused or removed passes are left out. The response is cached for up to a minute.",
			responseSchema: OperatorPassWallResponse,
			statusCode: 200,
			security: [],
			tags: TAG,
		}),
		async (ctx) => {
			ctx.header('Cache-Control', 'public, max-age=60');
			return ctx.json(await getOperatorPassWallService().publication.listPublicWall());
		},
	);
	app.get(
		'/operator-pass/releases/latest',
		HostedOnlyRoute,
		RateLimitMiddleware(OperatorPassRateLimitConfigs.OPERATOR_PASS_WALL),
		OpenAPI({
			operationId: 'get_operator_pass_latest_release',
			summary: 'Get latest Operators list',
			description:
				'Returns the latest published The Operators of list, with the release tag, the release date and the sorted names, for the homepage feature.',
			responseSchema: OperatorPassLatestReleaseResponse,
			statusCode: 200,
			security: [],
			tags: TAG,
		}),
		async (ctx) => {
			ctx.header('Cache-Control', 'public, max-age=300');
			return ctx.json({release: await getOperatorPassWallService().releases.latestRelease()});
		},
	);
}
