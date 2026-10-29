// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import GeoIP from '@app/features/app/state/GeoIP';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import OperatorPassHoldings from '@app/features/premium/state/OperatorPassHoldings';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import Users from '@app/features/user/state/Users';
import type {
	OperatorPassCheckoutRequest,
	OperatorPassCheckoutResponse,
	OperatorPassListingResponse,
	OperatorPassListingUpdateRequest,
	OperatorPassOfferAcceptRequest,
	OperatorPassOfferResponse,
	OperatorPassPassesResponse,
	OperatorPassPurchaseListResponse,
	OperatorPassPurchaseResponse,
	OperatorPassStateResponse,
	OperatorPassWithdrawRequest,
} from '@fluxer/schema/src/domains/operator_pass/OperatorPassSchemas';

const logger = new Logger('OperatorPass');

export function getCountryCode(): string | undefined {
	return GeoIP.countryCode?.toUpperCase() ?? undefined;
}

function applyHolderToCurrentUser(state: OperatorPassStateResponse): void {
	const user = Users.currentUser;
	if (!user) return;
	const since = state.holder?.since ?? null;
	const current = user.operatorPassSince ?? null;
	if ((current?.getTime() ?? null) === (since ? new Date(since).getTime() : null)) return;
	Users.handleUserUpdate({...user.toJSON(), operator_pass_since: since});
	UserProfileCommands.clearCurrentUserProfiles();
}

export async function fetchState(): Promise<OperatorPassStateResponse> {
	const countryCode = getCountryCode();
	const response = await http.get<OperatorPassStateResponse>(Endpoints.OPERATOR_PASS_STATE, {
		query: countryCode ? {country_code: countryCode} : {},
	});
	applyHolderToCurrentUser(response.body);
	return response.body;
}

export async function createCheckout(request: OperatorPassCheckoutRequest): Promise<string> {
	try {
		const response = await http.post<OperatorPassCheckoutResponse>(Endpoints.OPERATOR_PASS_CHECKOUT, {
			body: request,
		});
		logger.info('Operator Pass checkout created', {quantity: request.quantity});
		return response.body.url;
	} catch (error) {
		logger.error('Operator Pass checkout failed', error);
		throw error;
	}
}

export async function fetchPurchases(): Promise<OperatorPassPurchaseListResponse> {
	const response = await http.get<OperatorPassPurchaseListResponse>(Endpoints.OPERATOR_PASS_PURCHASES);
	return response.body;
}

export async function withdrawPurchase(
	purchaseId: string,
	request: OperatorPassWithdrawRequest,
): Promise<OperatorPassPurchaseResponse> {
	try {
		const response = await http.post<OperatorPassPurchaseResponse>(
			Endpoints.OPERATOR_PASS_PURCHASE_WITHDRAW(purchaseId),
			{
				body: request,
			},
		);
		logger.info('Operator Pass purchase withdrawn', {quantity: response.body.quantity});
		UserProfileCommands.clearCurrentUserProfiles();
		return response.body;
	} catch (error) {
		logger.error('Operator Pass withdrawal failed', error);
		throw error;
	}
}

export async function fetchListing(): Promise<OperatorPassListingResponse> {
	const response = await http.get<OperatorPassListingResponse>(Endpoints.OPERATOR_PASS_LISTING);
	return response.body;
}

export async function updateListing(request: OperatorPassListingUpdateRequest): Promise<OperatorPassListingResponse> {
	try {
		const response = await http.put<OperatorPassListingResponse>(Endpoints.OPERATOR_PASS_LISTING, {body: request});
		logger.info("Operators' wall listing updated", {optOut: request.wall_opt_out});
		return response.body;
	} catch (error) {
		logger.error("Operators' wall listing update failed", error);
		throw error;
	}
}

export async function fetchPasses(): Promise<OperatorPassPassesResponse> {
	const response = await http.get<OperatorPassPassesResponse>(Endpoints.OPERATOR_PASS_PASSES);
	OperatorPassHoldings.setPasses(response.body);
	OperatorPassHoldings.markIncomingOffersSeen();
	return response.body;
}

async function refreshPassesQuietly(): Promise<void> {
	try {
		await fetchPasses();
	} catch (error) {
		logger.warn('Operator Pass refresh failed', error);
	}
}

export async function createOffer(
	passId: string,
	recipientId: string,
	confirmLastPass: boolean,
): Promise<OperatorPassOfferResponse> {
	try {
		const response = await http.post<OperatorPassOfferResponse>(Endpoints.OPERATOR_PASS_PASS_OFFERS(passId), {
			body: {recipient_id: recipientId, confirm_last_pass: confirmLastPass},
		});
		logger.info('Operator Pass offer created');
		await refreshPassesQuietly();
		return response.body;
	} catch (error) {
		logger.error('Operator Pass offer failed', error);
		throw error;
	}
}

export async function fetchOffer(offerId: string): Promise<OperatorPassOfferResponse> {
	const response = await http.get<OperatorPassOfferResponse>(Endpoints.OPERATOR_PASS_OFFER(offerId));
	return response.body;
}

export async function withdrawOffer(offerId: string): Promise<OperatorPassOfferResponse> {
	const response = await http.delete<OperatorPassOfferResponse>(Endpoints.OPERATOR_PASS_OFFER(offerId));
	logger.info('Operator Pass offer withdrawn');
	await refreshPassesQuietly();
	return response.body;
}

export async function acceptOffer(
	offerId: string,
	request: OperatorPassOfferAcceptRequest,
): Promise<OperatorPassOfferResponse> {
	const response = await http.post<OperatorPassOfferResponse>(Endpoints.OPERATOR_PASS_OFFER_ACCEPT(offerId), {
		body: request,
	});
	logger.info('Operator Pass offer accepted', {status: response.body.status});
	await refreshPassesQuietly();
	UserProfileCommands.clearCurrentUserProfiles();
	return response.body;
}

export async function declineOffer(offerId: string): Promise<OperatorPassOfferResponse> {
	const response = await http.post<OperatorPassOfferResponse>(Endpoints.OPERATOR_PASS_OFFER_DECLINE(offerId));
	logger.info('Operator Pass offer declined');
	await refreshPassesQuietly();
	return response.body;
}

export async function withdrawPass(
	passId: string,
	request: OperatorPassWithdrawRequest,
): Promise<OperatorPassPassesResponse> {
	try {
		const response = await http.post<OperatorPassPassesResponse>(Endpoints.OPERATOR_PASS_PASS_WITHDRAW(passId), {
			body: request,
		});
		logger.info('Operator Pass withdrawn');
		OperatorPassHoldings.setPasses(response.body);
		UserProfileCommands.clearCurrentUserProfiles();
		return response.body;
	} catch (error) {
		logger.error('Operator Pass withdrawal failed', error);
		throw error;
	}
}
