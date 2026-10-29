// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {Db} from '@app/api/database/CassandraTypes';
import type {
	OperatorPassOfferRow,
	OperatorPassPurchaseRow,
	OperatorPassUnitRow,
	OperatorPassWithdrawalChannel,
} from '@app/api/database/types/OperatorPassTypes';
import type {DonationRepository} from '@app/api/donation/DonationRepository';
import {Logger} from '@app/api/Logger';
import type {OperatorPassServices} from '@app/api/middleware/OperatorPassServiceFactory';
import {getBillingRepository} from '@app/api/middleware/ServiceRegistry';
import type {User} from '@app/api/models/User';
import {findOperatorPassBusinessPurchase} from '@app/api/operator_pass/OperatorPassBusinessListing';
import {
	isOperatorPassPermanentlyRemoved,
	loadOperatorPassEntitlementState,
} from '@app/api/operator_pass/OperatorPassEntitlementService';
import type {
	OperatorPassHoldingService,
	OperatorPassOfferParams,
} from '@app/api/operator_pass/OperatorPassHoldingService';
import {OPERATOR_PASS_LABS_INVITE_URL} from '@app/api/operator_pass/OperatorPassLabsRole';
import {
	OPERATOR_PASS_WITHDRAWAL_RULE_VERSION,
	resolveOperatorPassWithdrawalRule,
} from '@app/api/operator_pass/OperatorPassPrices';
import {
	getOperatorPassCountryWithdrawalEndsAt,
	getOperatorPassWithdrawalEndsOn,
	isOperatorPassPurchaseWithdrawable,
	isOperatorPassUnitWithdrawable,
	isOperatorPassWithinWithdrawalDeadline,
	listOperatorPassCountryWithdrawableUnits,
} from '@app/api/operator_pass/OperatorPassPurchaseRules';
import type {OperatorPassRepository} from '@app/api/operator_pass/OperatorPassRepository';
import {isOperatorPassCurrency, operatorPassNow} from '@app/api/operator_pass/OperatorPassSchedule';
import type {OperatorPassWallService} from '@app/api/operator_pass/OperatorPassWallService';
import {getFirstInvoicePaymentIntentId} from '@app/api/stripe/StripeSubscriptionPeriod';
import {extractId} from '@app/api/stripe/StripeUtils';
import {StripeDonationCheckoutFulfilment} from '@app/api/stripe/services/StripeDonationCheckoutFulfilment';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {OperatorPassOfferBusyError} from '@fluxer/errors/src/domains/operator_pass/OperatorPassOfferBusyError';
import {OperatorPassWithdrawalUnavailableError} from '@fluxer/errors/src/domains/operator_pass/OperatorPassWithdrawalUnavailableError';
import {UnknownOperatorPassPurchaseError} from '@fluxer/errors/src/domains/operator_pass/UnknownOperatorPassPurchaseError';
import {UnknownOperatorPassUnitError} from '@fluxer/errors/src/domains/operator_pass/UnknownOperatorPassUnitError';
import {StripeError} from '@fluxer/errors/src/domains/payment/StripeError';
import {
	OPERATOR_PASS_COUNTRY_CONSENT_PREFIX,
	OPERATOR_PASS_PHASES,
} from '@fluxer/schema/src/domains/operator_pass/OperatorPassSchemas';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import type {IEmailService} from '@pkgs/email/src/IEmailService';
import {OPERATOR_PASS_TERMS_VERSION} from '@pkgs/email/src/operator_pass_terms/OperatorPassTerms';
import {seconds} from 'itty-time';
import type Stripe from 'stripe';

const APPLIED_TTL_SECONDS = seconds('365 days');
const PURCHASE_LOCK_TTL_SECONDS = seconds('2 minutes');

interface CheckoutPaymentReferences {
	paymentIntentId: string | null;
	invoiceId: string | null;
	subscriptionId: string | null;
}

export interface OperatorPassWithdrawParams {
	purchaser: User;
	purchaseId: string;
	name: string;
	channel: OperatorPassWithdrawalChannel;
	receivedAt: Date;
}

export interface OperatorPassUnitWithdrawParams {
	holder: User;
	passId: string;
	name: string;
	receivedAt: Date;
}

export function isOperatorPassCheckoutSession(session: Stripe.Checkout.Session): boolean {
	return session.metadata?.operator_pass === 'true';
}

interface OperatorPassFulfilmentDependencies {
	stripe: Stripe | null;
	userRepository: UserRepository;
	emailService: IEmailService;
	cacheService: ICacheService;
	donationRepository: DonationRepository;
	services: OperatorPassServices;
}

export function createOperatorPassFulfilmentService(
	dependencies: OperatorPassFulfilmentDependencies,
): OperatorPassFulfilmentService | null {
	if (Config.instance.selfHosted) {
		return null;
	}
	return new OperatorPassFulfilmentService(
		dependencies.stripe,
		dependencies.services.repository,
		dependencies.userRepository,
		dependencies.emailService,
		dependencies.cacheService,
		new StripeDonationCheckoutFulfilment(
			dependencies.stripe,
			dependencies.donationRepository,
			dependencies.emailService,
			dependencies.cacheService,
		),
		dependencies.services,
	);
}

export class OperatorPassFulfilmentService {
	readonly wallService: OperatorPassWallService;
	readonly holdingService: OperatorPassHoldingService;

	constructor(
		private readonly stripe: Stripe | null,
		readonly repository: OperatorPassRepository,
		private readonly userRepository: UserRepository,
		private readonly emailService: IEmailService,
		private readonly cacheService: ICacheService,
		private readonly donationFulfilment: StripeDonationCheckoutFulfilment,
		private readonly services: OperatorPassServices,
	) {
		this.wallService = services.wallService;
		this.holdingService = services.holdingService;
	}

	get removalService(): OperatorPassServices['removalService'] {
		return this.services.removalService;
	}

	async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
		if (session.payment_status === 'unpaid') {
			Logger.info(
				{sessionId: session.id, paymentStatus: session.payment_status},
				'Operator Pass checkout completed with unpaid status; deferring fulfilment until settlement',
			);
			return;
		}
		await this.fulfilCheckoutSession(session);
	}

	async handleAsyncPaymentSucceeded(session: Stripe.Checkout.Session): Promise<void> {
		await this.fulfilCheckoutSession(session);
	}

	async handleCheckoutSessionExpired(session: Stripe.Checkout.Session): Promise<void> {
		await this.withPurchaseLock(session.id, async () => {
			const purchase = await this.repository.findPurchase(session.id);
			if (purchase?.status !== 'pending') {
				return;
			}
			await this.repository.deletePurchase(purchase);
			Logger.info(
				{sessionId: session.id, purchaserId: purchase.purchaser_id},
				'Deleted the pending Operator Pass purchase of an expired checkout session',
			);
		});
	}

	handleAsyncPaymentFailed(session: Stripe.Checkout.Session): void {
		Logger.warn(
			{sessionId: session.id, paymentStatus: session.payment_status},
			'Async payment failed for Operator Pass checkout session',
		);
	}

	async findPurchaseByPaymentIntent(paymentIntentId: string): Promise<OperatorPassPurchaseRow | null> {
		return this.repository.findPurchaseByPaymentIntent(paymentIntentId);
	}

	async markFraudWarning(paymentIntentId: string): Promise<void> {
		const purchase = await this.repository.findPurchaseByPaymentIntent(paymentIntentId);
		if (!purchase || purchase.fraud_warning_at) {
			return;
		}
		await this.withCurrentPurchase(purchase, (current) =>
			this.repository.updatePurchase(current, {fraud_warning_at: Db.set(operatorPassNow())}),
		);
	}

	async listPurchases(purchaserId: UserID): Promise<Array<OperatorPassPurchaseRow>> {
		const purchases = await this.repository.listPurchasesByPurchaser(purchaserId);
		return purchases
			.filter((purchase) => purchase.status !== 'pending' || purchase.purchased_at != null)
			.sort((left, right) => right.created_at.getTime() - left.created_at.getTime());
	}

	async handleChargeRefunded(purchase: OperatorPassPurchaseRow, charge: Stripe.Charge): Promise<void> {
		await this.withCurrentPurchase(purchase, (current) => this.handleChargeRefundedLocked(current, charge));
	}

	async handleDisputeCreated(purchase: OperatorPassPurchaseRow, dispute: Stripe.Dispute): Promise<void> {
		await this.withCurrentPurchase(purchase, (current) => this.handleDisputeCreatedLocked(current, dispute));
	}

	async handleDisputeReleased(purchase: OperatorPassPurchaseRow, dispute: Stripe.Dispute): Promise<void> {
		await this.withCurrentPurchase(purchase, (current) => this.handleDisputeReleasedLocked(current, dispute));
	}

	async handleDisputeLost(
		purchase: OperatorPassPurchaseRow,
		dispute: Stripe.Dispute,
	): Promise<OperatorPassPurchaseRow> {
		return this.withCurrentPurchase(purchase, (current) => this.handleDisputeLostLocked(current, dispute));
	}

	private async handleChargeRefundedLocked(purchase: OperatorPassPurchaseRow, charge: Stripe.Charge): Promise<void> {
		if (
			purchase.status === 'duplicate_refunded' ||
			purchase.status === 'refunded' ||
			purchase.status === 'withdrawn' ||
			purchase.status === 'dispute_lost'
		) {
			Logger.debug(
				{sessionId: purchase.checkout_session_id, status: purchase.status, chargeId: charge.id},
				'Operator Pass refund already handled',
			);
			return;
		}
		const passRefunded = await this.passRefundedAmount(purchase, charge);
		if (passRefunded < purchase.amount_minor) {
			const quantity = Math.max(1, purchase.quantity ?? 1);
			const unitAmount = Math.round(purchase.amount_minor / quantity);
			const units = await this.repository.listUnitsByPurchase(purchase.checkout_session_id);
			const ended = units.filter((unit) => unit.status !== 'held').length;
			const covered = unitAmount > 0 ? Math.floor(passRefunded / unitAmount) : 0;
			const toEnd = Math.max(0, covered - ended);
			if (toEnd > 0) {
				await this.holdingService.endPurchaseUnits(purchase, 'refund', 'revoked', toEnd);
			}
			const remaining = (await this.repository.listUnitsByPurchase(purchase.checkout_session_id)).filter(
				(unit) => unit.status === 'held',
			).length;
			if (remaining === 0) {
				await this.repository.updatePurchase(purchase, {status: Db.set('refunded'), refunded_at: Db.set(new Date())});
				await this.reviewBusinessListing(purchase);
			}
			Logger.info(
				{
					sessionId: purchase.checkout_session_id,
					chargeId: charge.id,
					amountRefunded: charge.amount_refunded,
					passRefunded,
					passAmount: purchase.amount_minor,
					revoked: toEnd,
					remaining,
				},
				'Partial refund of an Operator Pass purchase; revoked the passes it covers',
			);
			return;
		}
		await this.holdingService.endPurchaseUnits(purchase, 'refund', 'revoked');
		await this.repository.updatePurchase(purchase, {status: Db.set('refunded'), refunded_at: Db.set(new Date())});
		await this.reviewBusinessListing(purchase);
		Logger.info(
			{sessionId: purchase.checkout_session_id, purchaserId: purchase.purchaser_id},
			'Operator Pass revoked after a refund',
		);
	}

	private async reviewBusinessListing(purchase: OperatorPassPurchaseRow): Promise<void> {
		const userId = purchase.purchaser_id;
		if (!(await this.wallService.getEntry(userId))?.live_business) {
			return;
		}
		let qualifying: OperatorPassPurchaseRow | null = null;
		if (this.stripe) {
			try {
				qualifying = await findOperatorPassBusinessPurchase({
					stripe: this.stripe,
					repository: this.repository,
					userId,
					now: operatorPassNow(),
				});
			} catch (error) {
				Logger.warn({error, userId}, 'Could not check a business listing again, so it goes back to personal');
			}
		}
		if (!qualifying) {
			await this.wallService.endBusinessListing(userId);
		}
	}

	private async passRefundedAmount(purchase: OperatorPassPurchaseRow, charge: Stripe.Charge): Promise<number> {
		if (charge.refunded) {
			return purchase.amount_minor;
		}
		if (!purchase.subscription_id) {
			return charge.amount_refunded;
		}
		if (!this.stripe) {
			throw new StripeError('Stripe client not available to split an Operator Pass refund');
		}
		const refunds = await this.stripe.refunds.list({charge: charge.id, limit: 100}).autoPagingToArray({limit: 1000});
		const donationAmount = Math.max(0, charge.amount - purchase.amount_minor);
		const donationRefunded = refunds
			.filter(
				(refund) =>
					refund.status !== 'failed' &&
					refund.status !== 'canceled' &&
					!refund.metadata?.checkout_session_id &&
					(refund.metadata?.subscription_id === purchase.subscription_id || refund.amount === donationAmount),
			)
			.reduce((total, refund) => total + refund.amount, 0);
		return Math.max(0, charge.amount_refunded - Math.min(donationRefunded, donationAmount));
	}

	private async applyRefundsMadeElsewhere(purchase: OperatorPassPurchaseRow): Promise<OperatorPassPurchaseRow> {
		if (!this.stripe || !purchase.payment_intent_id || !['completed', 'disputed'].includes(purchase.status)) {
			return purchase;
		}
		const intent = await this.stripe.paymentIntents.retrieve(purchase.payment_intent_id, {expand: ['latest_charge']});
		const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
		if (!charge || charge.amount_refunded === 0) {
			return purchase;
		}
		await this.handleChargeRefundedLocked(purchase, charge);
		return (await this.repository.findPurchase(purchase.checkout_session_id)) ?? purchase;
	}

	private async handleDisputeCreatedLocked(purchase: OperatorPassPurchaseRow, dispute: Stripe.Dispute): Promise<void> {
		const disputeFields = {
			dispute_id: Db.set(dispute.id),
			dispute_reason: Db.set(dispute.reason ?? null),
			dispute_status: Db.set(dispute.status),
			disputed_at: Db.set(purchase.disputed_at ?? new Date(dispute.created * 1000)),
		};
		if (purchase.dispute_id === dispute.id && purchase.dispute_closed_at != null) {
			Logger.info(
				{sessionId: purchase.checkout_session_id, status: purchase.status, disputeId: dispute.id},
				'Dispute opened event arrived after the dispute closed; leaving the Operator Pass as it is',
			);
			return;
		}
		if (purchase.status !== 'completed') {
			Logger.info(
				{sessionId: purchase.checkout_session_id, status: purchase.status, disputeId: dispute.id},
				'Dispute on an Operator Pass purchase that has no active pass to pause',
			);
			if (purchase.status !== 'pending') {
				await this.repository.updatePurchase(purchase, disputeFields);
			}
			return;
		}
		await this.holdingService.setPurchasePaused(purchase, true);
		await this.repository.updatePurchase(purchase, {...disputeFields, status: Db.set('disputed')});
		await this.reviewBusinessListing(purchase);
		Logger.info(
			{sessionId: purchase.checkout_session_id, purchaserId: purchase.purchaser_id, disputeId: dispute.id},
			'Operator Pass paused while a payment dispute is open',
		);
	}

	private async handleDisputeReleasedLocked(purchase: OperatorPassPurchaseRow, dispute: Stripe.Dispute): Promise<void> {
		if (purchase.status !== 'disputed') {
			Logger.debug(
				{sessionId: purchase.checkout_session_id, status: purchase.status, disputeId: dispute.id},
				'Closed dispute on an Operator Pass purchase that the dispute did not pause',
			);
			if (purchase.status !== 'pending') {
				await this.repository.updatePurchase(purchase, {
					dispute_id: Db.set(dispute.id),
					dispute_status: Db.set(dispute.status),
					dispute_closed_at: Db.set(new Date()),
				});
			}
			return;
		}
		const updated = await this.repository.updatePurchase(purchase, {
			status: Db.set('completed'),
			dispute_status: Db.set(dispute.status),
			dispute_closed_at: Db.set(new Date()),
		});
		await this.holdingService.setPurchasePaused(updated, false);
		Logger.info(
			{sessionId: purchase.checkout_session_id, purchaserId: purchase.purchaser_id, disputeStatus: dispute.status},
			'Operator Pass restored after a payment dispute closed without the money being returned',
		);
	}

	private async handleDisputeLostLocked(
		purchase: OperatorPassPurchaseRow,
		dispute: Stripe.Dispute,
	): Promise<OperatorPassPurchaseRow> {
		if (purchase.status === 'dispute_lost') {
			return purchase;
		}
		const active = purchase.status === 'disputed' || purchase.status === 'completed';
		if (active) {
			await this.holdingService.endPurchaseUnits(purchase, 'dispute', 'revoked');
		}
		const updated = await this.repository.updatePurchase(purchase, {
			status: Db.set(active ? 'dispute_lost' : purchase.status),
			dispute_id: Db.set(dispute.id),
			dispute_reason: Db.set(dispute.reason ?? null),
			dispute_status: Db.set(dispute.status),
			disputed_at: Db.set(purchase.disputed_at ?? new Date(dispute.created * 1000)),
			dispute_closed_at: Db.set(new Date()),
		});
		await this.reviewBusinessListing(purchase);
		Logger.info(
			{sessionId: purchase.checkout_session_id, purchaserId: purchase.purchaser_id, disputeId: dispute.id},
			'Operator Pass ended after a payment dispute returned the money',
		);
		return updated;
	}

	async withdraw({
		purchaser,
		purchaseId,
		name,
		channel,
		receivedAt,
	}: OperatorPassWithdrawParams): Promise<OperatorPassPurchaseRow> {
		const found = await this.repository.findPurchase(purchaseId);
		if (!found || found.purchaser_id !== purchaser.id) {
			throw new UnknownOperatorPassPurchaseError();
		}
		return this.withPurchaseLock(purchaseId, async () => {
			const purchase = await this.applyRefundsMadeElsewhere((await this.repository.findPurchase(purchaseId)) ?? found);
			const refundedBefore = purchase.status === 'refunded' && channel !== 'button';
			const units = await this.repository.listUnitsByPurchase(purchase.checkout_session_id);
			const countryUnits = listOperatorPassCountryWithdrawableUnits(purchase, units, receivedAt);
			const withinPeriod = refundedBefore
				? isOperatorPassWithinWithdrawalDeadline(purchase, receivedAt)
				: isOperatorPassPurchaseWithdrawable(purchase, units, receivedAt) || countryUnits.length > 0;
			if (!withinPeriod || !purchase.payment_intent_id) {
				throw new OperatorPassWithdrawalUnavailableError();
			}
			const amountMinor =
				units.length === 0
					? purchase.amount_minor
					: Math.round(purchase.amount_minor / Math.max(1, purchase.quantity ?? 1)) * countryUnits.length;
			const returned = refundedBefore ? null : await this.returnPassPayment(purchase, amountMinor, 'all');
			if (!refundedBefore) {
				await this.holdingService.endPurchaseUnits(
					purchase,
					'withdrawal',
					'withdrawn',
					Number.POSITIVE_INFINITY,
					units.length === 0 ? null : new Set(countryUnits.map((unit) => unit.pass_id)),
				);
			}
			const remaining = (await this.repository.listUnitsByPurchase(purchase.checkout_session_id)).filter(
				(unit) => unit.status === 'held',
			);
			const withdrawn = await this.repository.updatePurchase(purchase, {
				...(remaining.length === 0
					? {status: Db.set('withdrawn'), refunded_at: Db.set(purchase.refunded_at ?? new Date())}
					: {}),
				withdrawn_at: Db.set(receivedAt),
				withdrawal_name: Db.set(name),
				withdrawal_refund_id: Db.set(returned?.refundId ?? null),
				withdrawal_channel: Db.set(channel),
			});
			await this.reviewBusinessListing(purchase);
			Logger.info(
				{sessionId: purchase.checkout_session_id, purchaserId: purchaser.id, channel},
				'Operator Pass purchase withdrawn',
			);
			await this.sendWithdrawalReceipt({
				purchase: withdrawn,
				purchaser,
				name,
				receivedAt,
				amountMinor,
				refundViaDispute: returned?.viaDispute ?? false,
				lastPass: (await this.holdingService.queries.listHeldUnits(purchaser.id)).length === 0,
			});
			return withdrawn;
		});
	}

	async withdrawUnit({holder, passId, name, receivedAt}: OperatorPassUnitWithdrawParams): Promise<OperatorPassUnitRow> {
		const unit = await this.repository.findUnit(passId);
		if (!unit || unit.holder_id !== holder.id || !unit.purchase_id) {
			throw new UnknownOperatorPassUnitError();
		}
		const purchaseId = unit.purchase_id;
		return this.withPurchaseLock(purchaseId, async () => {
			const found = await this.repository.findPurchase(purchaseId);
			const purchase = found ? await this.applyRefundsMadeElsewhere(found) : null;
			const current = await this.repository.findUnit(passId);
			if (!purchase || !current || purchase.purchaser_id !== holder.id) {
				throw new UnknownOperatorPassUnitError();
			}
			if (!isOperatorPassUnitWithdrawable(purchase, current, receivedAt) || !purchase.payment_intent_id) {
				throw new OperatorPassWithdrawalUnavailableError();
			}
			const amountMinor = Math.round(purchase.amount_minor / Math.max(1, purchase.quantity ?? 1));
			const returned = await this.returnPassPayment(purchase, amountMinor, current.pass_id);
			await this.holdingService.withdrawUnit(current, purchase);
			const remaining = (await this.repository.listUnitsByPurchase(purchaseId)).filter(
				(unit) => unit.status === 'held',
			);
			await this.repository.updatePurchase(purchase, {
				...(remaining.length === 0
					? {status: Db.set('withdrawn'), refunded_at: Db.set(purchase.refunded_at ?? new Date())}
					: {}),
				withdrawn_at: Db.set(receivedAt),
				withdrawal_name: Db.set(name),
				withdrawal_refund_id: Db.set(returned.refundId),
				withdrawal_channel: Db.set('button'),
			});
			await this.reviewBusinessListing(purchase);
			Logger.info({sessionId: purchaseId, passId, holderId: holder.id}, 'Operator Pass withdrawn under a country rule');
			await this.sendWithdrawalReceipt({
				purchase,
				purchaser: holder,
				name,
				receivedAt,
				amountMinor,
				refundViaDispute: returned.viaDispute,
				lastPass: (await this.holdingService.queries.listHeldUnits(holder.id)).length === 0,
			});
			return (await this.repository.findUnit(passId)) ?? current;
		});
	}

	private async returnPassPayment(
		purchase: OperatorPassPurchaseRow,
		amountMinor: number,
		idempotencyScope: string,
	): Promise<{refundId: string | null; viaDispute: boolean}> {
		try {
			const refund = await this.refundPassAmount(purchase, amountMinor, `operator_pass_withdrawal:${idempotencyScope}`);
			return {refundId: refund.id, viaDispute: false};
		} catch (error) {
			if (purchase.status !== 'disputed' || !purchase.dispute_id || !isChargeDisputedError(error) || !this.stripe) {
				throw error;
			}
			await this.stripe.disputes.close(purchase.dispute_id);
			Logger.info(
				{sessionId: purchase.checkout_session_id, disputeId: purchase.dispute_id},
				'Accepted the payment dispute so the withdrawal returns the money',
			);
			return {refundId: null, viaDispute: true};
		}
	}

	private async sendWithdrawalReceipt(params: {
		purchase: OperatorPassPurchaseRow;
		purchaser: User;
		name: string;
		receivedAt: Date;
		amountMinor: number;
		refundViaDispute: boolean;
		lastPass: boolean;
	}): Promise<void> {
		const {purchase, purchaser} = params;
		if (!purchaser.email) {
			Logger.error({sessionId: purchase.checkout_session_id}, 'No address for the Operator Pass withdrawal receipt');
			return;
		}
		const sent = await this.emailService.send(
			'operator_pass_withdrawal_receipt',
			purchaser.email,
			{
				cancellation: purchase.withdrawal_days != null,
				name: params.name,
				receivedAt: params.receivedAt,
				invoiceNumber: purchase.invoice_number ?? null,
				orderDate: purchase.purchased_at ?? purchase.created_at,
				amountMinor: params.amountMinor,
				currency: purchase.currency,
				lastPass: params.lastPass,
				hasDonation: purchase.subscription_id != null,
				refundViaDispute: params.refundViaDispute,
				timeZone: purchaser.timezone,
			},
			purchaser.locale,
		);
		if (!sent) {
			Logger.error({sessionId: purchase.checkout_session_id}, 'Failed to send the Operator Pass withdrawal receipt');
		}
	}

	async refundPassAmount(
		purchase: OperatorPassPurchaseRow,
		amountMinor: number,
		reason: string,
	): Promise<Stripe.Refund> {
		if (!this.stripe) {
			throw new StripeError('Stripe client not available for an Operator Pass refund');
		}
		if (!purchase.payment_intent_id) {
			throw new StripeError('Operator Pass purchase has no payment intent to refund');
		}
		const refund = await this.stripe.refunds.create(
			{
				payment_intent: purchase.payment_intent_id,
				amount: amountMinor,
				reason: 'requested_by_customer',
				metadata: {checkout_session_id: purchase.checkout_session_id, rejection_reason: reason},
			},
			{idempotencyKey: `operator-pass-${reason}:${purchase.checkout_session_id}`},
		);
		try {
			await getBillingRepository().refunds.upsertFromStripe(refund);
		} catch (mirrorErr) {
			Logger.error(
				{mirrorErr, refundId: refund.id},
				'Mirror upsert failed for an Operator Pass refund; reconciler will heal',
			);
		}
		return refund;
	}

	private async fulfilCheckoutSession(session: Stripe.Checkout.Session): Promise<void> {
		const appliedKey = getAppliedKey(session.id);
		if (await this.cacheService.get<boolean>(appliedKey)) {
			Logger.debug({sessionId: session.id}, 'Operator Pass checkout already fulfilled');
			return;
		}
		await this.withPurchaseLock(session.id, async () => {
			const purchase = (await this.repository.findPurchase(session.id)) ?? (await this.recoverPurchase(session));
			if (!purchase) {
				Logger.error({sessionId: session.id}, 'No Operator Pass purchase found for checkout session, skipping event');
				return;
			}
			if (purchase.status !== 'pending') {
				await this.cacheService.set(appliedKey, true, APPLIED_TTL_SECONDS);
				return;
			}
			const purchaser = await this.userRepository.findUnique(purchase.purchaser_id);
			if (!purchaser) {
				Logger.error({sessionId: session.id, userId: purchase.purchaser_id}, 'Operator Pass purchaser not found');
				throw new StripeError('Operator Pass purchaser not found');
			}
			await this.fulfilPendingPurchase(session, purchase, purchaser);
		});
	}

	private async fulfilPendingPurchase(
		session: Stripe.Checkout.Session,
		pending: OperatorPassPurchaseRow,
		purchaser: User,
	): Promise<void> {
		const appliedKey = getAppliedKey(session.id);
		let purchase = pending;
		const references = await this.resolvePaymentReferences(session);
		purchase = await this.repository.updatePurchase(purchase, {
			payment_intent_id: Db.set(references.paymentIntentId ?? purchase.payment_intent_id),
			invoice_id: Db.set(references.invoiceId ?? purchase.invoice_id),
			subscription_id: Db.set(references.subscriptionId ?? purchase.subscription_id),
		});
		if (await this.isRefusedPurchase(purchaser)) {
			await this.refundRefusedPurchase(purchase);
			await this.registerDonation(session, references, purchaser);
			await this.repository.updatePurchase(purchase, {
				status: Db.set('duplicate_refunded'),
				completed_at: Db.set(new Date()),
			});
			await this.cacheService.set(appliedKey, true, APPLIED_TTL_SECONDS);
			return;
		}
		purchase = await this.recordPurchaseTerms(purchase, session);
		await this.sendConfirmationOnce(purchase, purchaser, session);
		purchase = await this.repository.updatePurchase(purchase, {
			confirmation_sent_at: Db.set(purchase.confirmation_sent_at ?? new Date()),
		});
		const deliveredAt = purchase.perks_granted_at ?? operatorPassNow();
		const holdingService = this.holdingService;
		const delivery: Parameters<OperatorPassHoldingService['deliverPurchase']>[0] = {
			purchase,
			buyer: purchaser,
			deliveredAt,
			choice: null,
		};
		if (purchase.wall_opt_out != null) {
			delivery.choice = {
				name: purchase.wall_opt_out ? null : (purchase.wall_name ?? null),
				optedOut: purchase.wall_opt_out || !purchase.wall_name,
			};
		}
		await holdingService.deliverPurchase(delivery);
		await this.registerDonation(session, references, purchaser);
		await this.repository.updatePurchase(purchase, {
			status: Db.set('completed'),
			completed_at: Db.set(purchase.completed_at ?? new Date()),
			perks_granted_at: Db.set(deliveredAt),
		});
		await this.recordDeliveryInBilling(purchase, deliveredAt);
		await this.sendWelcomeOnce(purchase, purchaser, deliveredAt);
		await this.cacheService.set(appliedKey, true, APPLIED_TTL_SECONDS);
		Logger.info(
			{sessionId: session.id, purchaserId: purchase.purchaser_id, quantity: purchase.quantity ?? 1},
			'Operator Pass checkout fulfilled',
		);
	}

	private async registerDonation(
		session: Stripe.Checkout.Session,
		references: CheckoutPaymentReferences,
		purchaser: User,
	): Promise<void> {
		if (!references.subscriptionId) {
			return;
		}
		await this.donationFulfilment.registerDonation(session, {
			email: resolveDonorEmail(session, purchaser),
			locale: session.metadata?.operator_pass_locale ?? purchaser.locale ?? null,
			isBusiness: false,
		});
	}

	private async isRefusedPurchase(purchaser: User): Promise<boolean> {
		const {removal} = await loadOperatorPassEntitlementState(this.repository, purchaser.id);
		return isOperatorPassPermanentlyRemoved(removal);
	}

	private async recordPurchaseTerms(
		purchase: OperatorPassPurchaseRow,
		session: Stripe.Checkout.Session,
	): Promise<OperatorPassPurchaseRow> {
		if (purchase.purchased_at) {
			return purchase;
		}
		const purchasedAt = operatorPassNow();
		const rule = resolveOperatorPassWithdrawalRule(
			Config.operatorPass.withdrawalCountries,
			[
				purchase.withdrawal_country,
				session.customer_details?.address?.country,
				await this.resolveCardCountry(purchase.payment_intent_id ?? null),
			],
			purchase.currency,
		);
		if (rule && !purchase.withdrawal_country) {
			Logger.info(
				{sessionId: purchase.checkout_session_id, country: rule.country, days: rule.days},
				'Operator Pass country withdrawal rule applied after payment; section 12 replaces the waiver the buyer ticked',
			);
		}
		return this.repository.updatePurchase(purchase, {
			purchased_at: Db.set(purchasedAt),
			withdrawal_country: Db.set(rule?.country ?? null),
			withdrawal_days: Db.set(rule?.days ?? null),
			withdrawal_rule_version: Db.set(rule ? OPERATOR_PASS_WITHDRAWAL_RULE_VERSION : null),
			withdrawal_ends_at: Db.set(getOperatorPassCountryWithdrawalEndsAt(purchasedAt, rule?.days ?? null)),
			stripe_terms_consent: Db.set(session.consent?.terms_of_service ?? null),
			invoice_number: Db.set(await this.resolveInvoiceNumber(purchase)),
			operator_pass_terms_version: Db.set(purchase.operator_pass_terms_version ?? OPERATOR_PASS_TERMS_VERSION),
		});
	}

	private async describePaymentMethod(paymentIntentId: string | null): Promise<string | null> {
		if (!this.stripe || !paymentIntentId) {
			return null;
		}
		try {
			const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId, {expand: ['latest_charge']});
			const details = typeof intent.latest_charge === 'object' ? intent.latest_charge?.payment_method_details : null;
			if (!details) {
				return null;
			}
			if (details.type === 'card' && details.card) {
				const brand = details.card.brand
					? details.card.brand.charAt(0).toUpperCase() + details.card.brand.slice(1)
					: 'Card';
				return details.card.last4 ? `${brand} ···· ${details.card.last4}` : brand;
			}
			return details.type === 'pix'
				? 'Pix'
				: details.type.charAt(0).toUpperCase() + details.type.slice(1).replaceAll('_', ' ');
		} catch (error) {
			Logger.warn({error, paymentIntentId}, 'Failed to describe the payment method of an Operator Pass payment');
			return null;
		}
	}

	private async resolveCardCountry(paymentIntentId: string | null): Promise<string | null> {
		if (!this.stripe || !paymentIntentId) {
			return null;
		}
		try {
			const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId, {expand: ['latest_charge']});
			const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
			return charge?.payment_method_details?.card?.country ?? null;
		} catch (error) {
			Logger.warn({error, paymentIntentId}, 'Failed to read the card country of an Operator Pass payment');
			return null;
		}
	}

	private async recordDeliveryInBilling(purchase: OperatorPassPurchaseRow, deliveredAt: Date): Promise<void> {
		if (!this.stripe || !purchase.payment_intent_id) {
			return;
		}
		try {
			await this.stripe.paymentIntents.update(purchase.payment_intent_id, {
				metadata: {operator_pass_delivered_at: deliveredAt.toISOString()},
			});
		} catch (error) {
			Logger.warn(
				{error, sessionId: purchase.checkout_session_id},
				'Failed to record the Operator Pass delivery time on the payment',
			);
		}
	}

	private async resolveInvoiceNumber(purchase: OperatorPassPurchaseRow): Promise<string | null> {
		if (!this.stripe) {
			return null;
		}
		try {
			if (purchase.invoice_id) {
				const invoice = await this.stripe.invoices.retrieve(purchase.invoice_id);
				if (invoice.number) {
					return invoice.number;
				}
			}
			if (!purchase.payment_intent_id) {
				return null;
			}
			const intent = await this.stripe.paymentIntents.retrieve(purchase.payment_intent_id, {expand: ['latest_charge']});
			const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
			return charge?.receipt_number ?? null;
		} catch (error) {
			Logger.warn(
				{error, sessionId: purchase.checkout_session_id},
				'Failed to read the invoice number of an Operator Pass payment',
			);
			return null;
		}
	}

	private async sendConfirmationOnce(
		purchase: OperatorPassPurchaseRow,
		purchaser: User,
		session: Stripe.Checkout.Session,
	): Promise<void> {
		const sentKey = `operator_pass:confirmation:sent:${purchase.checkout_session_id}`;
		if (purchase.confirmation_sent_at || (await this.cacheService.get<boolean>(sentKey))) {
			return;
		}
		const email = purchaser.email ?? session.customer_details?.email ?? session.customer_email;
		if (!email) {
			throw new StripeError('Operator Pass buyer has no email address for the purchase confirmation');
		}
		const sent = await this.emailService.send(
			'operator_pass_purchase_confirmation',
			email,
			{
				invoiceNumber: purchase.invoice_number ?? null,
				orderDate: purchase.purchased_at ?? operatorPassNow(),
				quantity: Math.max(1, purchase.quantity ?? 1),
				amountMinor: purchase.amount_minor,
				currency: purchase.currency,
				waiverConsentAt: purchase.waiver_consent_at ?? null,
				countryConsent: purchase.waiver_consent_version?.startsWith(OPERATOR_PASS_COUNTRY_CONSENT_PREFIX) ?? false,
				withdrawalDays: purchase.withdrawal_days ?? null,
				withdrawalEndsOn:
					purchase.withdrawal_days != null && purchase.withdrawal_ends_at
						? getOperatorPassWithdrawalEndsOn(purchase.withdrawal_ends_at)
						: null,
				wallName: await this.resolveConfirmationWallName(purchase),
				unitAmountMinor: Math.round(purchase.amount_minor / Math.max(1, purchase.quantity ?? 1)),
				paymentMethod: await this.describePaymentMethod(purchase.payment_intent_id ?? null),
				consentText: purchase.waiver_consent_text ?? null,
				timeZone: purchaser.timezone,
			},
			purchaser.locale ?? session.metadata?.operator_pass_locale ?? null,
		);
		if (!sent) {
			throw new StripeError('Failed to send the Operator Pass purchase confirmation; the pass is not granted');
		}
		await this.cacheService.set(sentKey, true, APPLIED_TTL_SECONDS);
	}

	private async countHeldPasses(user: User): Promise<number> {
		return (await this.holdingService.queries.listHeldUnits(user.id)).length;
	}

	private async resolveConfirmationWallName(purchase: OperatorPassPurchaseRow): Promise<string | null> {
		if (purchase.wall_opt_out == null) {
			const entry = await this.wallService.getEntry(purchase.purchaser_id);
			return entry && !entry.opted_out ? (entry.name ?? null) : null;
		}
		return purchase.wall_opt_out ? null : (purchase.wall_name ?? null);
	}

	private async refundRefusedPurchase(purchase: OperatorPassPurchaseRow): Promise<void> {
		if (!this.stripe) {
			throw new StripeError('Stripe client not available for an Operator Pass refusal refund');
		}
		if (!purchase.payment_intent_id) {
			throw new StripeError('Operator Pass refused purchase has no payment intent to refund');
		}
		Logger.warn(
			{sessionId: purchase.checkout_session_id, purchaserId: purchase.purchaser_id},
			'Purchaser lost the Operator Pass permanently; refunding the purchase',
		);
		const refund = await this.stripe.refunds.create(
			{
				payment_intent: purchase.payment_intent_id,
				...(purchase.subscription_id ? {amount: purchase.amount_minor} : {}),
				metadata: {
					checkout_session_id: purchase.checkout_session_id,
					rejection_reason: 'operator_pass_removed',
				},
			},
			{idempotencyKey: `operator-pass-duplicate-refund:${purchase.checkout_session_id}`},
		);
		try {
			await getBillingRepository().refunds.upsertFromStripe(refund);
		} catch (mirrorErr) {
			Logger.error(
				{mirrorErr, refundId: refund.id},
				'Mirror upsert failed for an Operator Pass refusal refund; reconciler will heal',
			);
		}
	}

	private async withCurrentPurchase<T>(
		purchase: OperatorPassPurchaseRow,
		action: (current: OperatorPassPurchaseRow) => Promise<T>,
	): Promise<T> {
		return this.withPurchaseLock(purchase.checkout_session_id, async () =>
			action((await this.repository.findPurchase(purchase.checkout_session_id)) ?? purchase),
		);
	}

	async createOffer(params: OperatorPassOfferParams): Promise<OperatorPassOfferRow> {
		return this.withLock(
			`operator_pass:offer_lock:${params.sender.id}`,
			() => this.holdingService.createOffer(params),
			() => new OperatorPassOfferBusyError(),
		);
	}

	private async withPurchaseLock<T>(
		checkoutSessionId: string,
		action: () => Promise<T>,
		busyError: () => Error = () => new StripeError('Operator Pass purchase is busy; retrying'),
	): Promise<T> {
		return this.withLock(`operator_pass:purchase_lock:${checkoutSessionId}`, action, busyError);
	}

	private async withLock<T>(lockKey: string, action: () => Promise<T>, busyError: () => Error): Promise<T> {
		const token = await this.cacheService.acquireLock(lockKey, PURCHASE_LOCK_TTL_SECONDS);
		if (!token) {
			throw busyError();
		}
		try {
			return await action();
		} finally {
			await this.cacheService.releaseLock(lockKey, token);
		}
	}

	private async resolvePaymentReferences(session: Stripe.Checkout.Session): Promise<CheckoutPaymentReferences> {
		const subscriptionId = extractId(session.subscription);
		const invoiceId = extractId(session.invoice);
		const sessionPaymentIntentId = extractId(session.payment_intent);
		if (sessionPaymentIntentId || !subscriptionId) {
			return {paymentIntentId: sessionPaymentIntentId, invoiceId, subscriptionId};
		}
		if (!this.stripe) {
			throw new StripeError('Stripe client not available for Operator Pass invoice lookup');
		}
		const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, {
			expand: ['latest_invoice.payments'],
		});
		const latestInvoice = typeof subscription.latest_invoice === 'string' ? null : subscription.latest_invoice;
		const invoice =
			invoiceId && invoiceId !== latestInvoice?.id
				? await this.stripe.invoices.retrieve(invoiceId, {expand: ['payments']})
				: latestInvoice;
		const paymentIntentId = getFirstInvoicePaymentIntentId(invoice ?? null);
		if (!paymentIntentId) {
			throw new StripeError('Operator Pass subscription checkout has no paid invoice yet');
		}
		return {paymentIntentId, invoiceId: invoice?.id ?? invoiceId, subscriptionId};
	}

	private async recoverPurchase(session: Stripe.Checkout.Session): Promise<OperatorPassPurchaseRow | null> {
		const metadata = session.metadata ?? {};
		const purchaserId = metadata.operator_pass_purchaser_id;
		const amountMinor = Number(metadata.operator_pass_amount_minor);
		const quantity = Number(metadata.operator_pass_quantity ?? '1');
		const currency = metadata.operator_pass_currency;
		const phase = metadata.operator_pass_phase;
		if (
			!purchaserId ||
			!/^\d{1,20}$/u.test(purchaserId) ||
			!Number.isSafeInteger(amountMinor) ||
			!Number.isSafeInteger(quantity) ||
			quantity < 1 ||
			!currency ||
			!isOperatorPassCurrency(currency) ||
			!phase ||
			!(OPERATOR_PASS_PHASES as ReadonlyArray<string>).includes(phase)
		) {
			return null;
		}
		const purchase: OperatorPassPurchaseRow = {
			checkout_session_id: session.id,
			purchaser_id: createUserID(BigInt(purchaserId)),
			quantity,
			status: 'pending',
			phase,
			amount_minor: amountMinor,
			currency,
			quote_honored: metadata.operator_pass_quote_honored === 'true',
			payment_intent_id: null,
			invoice_id: null,
			subscription_id: null,
			created_at: new Date((session.created ?? Math.floor(Date.now() / 1000)) * 1000),
			completed_at: null,
			refunded_at: null,
			waiver_consent_at: parseDate(metadata.operator_pass_waiver_consent_at),
			waiver_consent_version: metadata.operator_pass_waiver_consent_version ?? null,
			waiver_consent_text: session.custom_text?.terms_of_service_acceptance?.message ?? null,
			waiver_consent_ip: null,
			waiver_consent_user_agent: null,
			wall_name: metadata.operator_pass_wall_name ?? null,
			wall_opt_out:
				metadata.operator_pass_wall_opt_out === undefined ? null : metadata.operator_pass_wall_opt_out === 'true',
			withdrawal_country: metadata.operator_pass_withdrawal_country ?? null,
			withdrawal_days: null,
			withdrawal_rule_version: null,
			fraud_warning_at: null,
			stripe_terms_consent: null,
			operator_pass_terms_version: metadata.operator_pass_terms_version ?? OPERATOR_PASS_TERMS_VERSION,
			purchased_at: null,
			withdrawal_ends_at: null,
			perks_granted_at: null,
			confirmation_sent_at: null,
			withdrawn_at: null,
			withdrawal_name: null,
			withdrawal_refund_id: null,
			withdrawal_channel: null,
			invoice_number: null,
			dispute_id: null,
			dispute_reason: null,
			dispute_status: null,
			disputed_at: null,
			dispute_closed_at: null,
			version: 1,
		};
		await this.repository.createPurchase(purchase);
		Logger.warn({sessionId: session.id, purchaserId}, 'Recovered Operator Pass purchase from checkout metadata');
		return purchase;
	}

	async sendWelcomeOnce(purchase: OperatorPassPurchaseRow, user: User, deliveredAt: Date): Promise<void> {
		if (!user.email) {
			Logger.warn({userId: user.id}, 'Operator Pass holder has no email; skipping welcome email');
			return;
		}
		const sentKey = `operator_pass:welcome:sent:${purchase.checkout_session_id}`;
		if (await this.cacheService.get<boolean>(sentKey)) {
			return;
		}
		const wallEntry = await this.wallService.getEntry(user.id);
		const sent = await this.emailService.send(
			'operator_pass_welcome',
			user.email,
			{
				labsInviteUrl: OPERATOR_PASS_LABS_INVITE_URL,
				invoiceNumber: purchase.invoice_number ?? null,
				deliveredAt,
				wallName: wallEntry && !wallEntry.opted_out ? (wallEntry.name ?? null) : null,
				passCount: await this.countHeldPasses(user),
				timeZone: user.timezone,
			},
			user.locale,
		);
		if (!sent) {
			Logger.error(
				{userId: user.id, sessionId: purchase.checkout_session_id},
				'Failed to send the Operator Pass welcome email',
			);
			return;
		}
		await this.cacheService.set(sentKey, true, APPLIED_TTL_SECONDS);
	}
}

function isChargeDisputedError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'charge_disputed';
}

function parseDate(value: string | undefined): Date | null {
	if (!value) {
		return null;
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveDonorEmail(session: Stripe.Checkout.Session, purchaser: User): string {
	const email = session.customer_details?.email ?? session.customer_email ?? purchaser.email;
	if (!email) {
		throw new StripeError('Operator Pass donation checkout has no donor email');
	}
	return email.trim().toLowerCase();
}

function getAppliedKey(checkoutSessionId: string): string {
	return `stripe:checkout:operator_pass:applied:${checkoutSessionId}`;
}
