// SPDX-License-Identifier: AGPL-3.0-or-later

import {getWithdrawalPeriodEndsAt} from '@app/api/billing/WithdrawalPeriod';
import type {OperatorPassPurchaseRow, OperatorPassUnitRow} from '@app/api/database/types/OperatorPassTypes';
import type {
	OperatorPassCurrency,
	OperatorPassPurchaseResponse,
	OperatorPassPurchaseStatus,
} from '@fluxer/schema/src/domains/operator_pass/OperatorPassSchemas';

const WITHDRAWABLE_STATUSES: ReadonlyArray<OperatorPassPurchaseStatus> = ['completed', 'disputed'];
const UNDELIVERED_WITHDRAWABLE_STATUSES: ReadonlyArray<OperatorPassPurchaseStatus> = [
	'pending',
	...WITHDRAWABLE_STATUSES,
];
const DAY_MS = 24 * 60 * 60 * 1000;

const COUNTRY_DEADLINE_UTC_OFFSET_MS = -5 * 60 * 60 * 1000;

export function getOperatorPassWithdrawalEndsOn(endsAt: Date): string {
	return new Date(endsAt.getTime() + COUNTRY_DEADLINE_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

function getOperatorPassCountryWithdrawalDeadline(endsAt: Date): Date {
	const [year, month, day] = getOperatorPassWithdrawalEndsOn(endsAt).split('-').map(Number) as [number, number, number];
	return new Date(Date.UTC(year, month - 1, day + 1) - COUNTRY_DEADLINE_UTC_OFFSET_MS);
}

export function getOperatorPassWithdrawalDeadline(purchase: OperatorPassPurchaseRow): Date | null {
	if (!purchase.withdrawal_ends_at) return null;
	return purchase.withdrawal_days != null
		? getOperatorPassCountryWithdrawalDeadline(purchase.withdrawal_ends_at)
		: purchase.withdrawal_ends_at;
}

export function isOperatorPassWithinWithdrawalDeadline(purchase: OperatorPassPurchaseRow, receivedAt: Date): boolean {
	const deadline = getOperatorPassWithdrawalDeadline(purchase);
	return deadline != null && receivedAt.getTime() < deadline.getTime();
}

export function getOperatorPassCountryWithdrawalEndsAt(purchasedAt: Date, days: number | null): Date {
	return days === null ? getWithdrawalPeriodEndsAt(purchasedAt) : new Date(purchasedAt.getTime() + days * DAY_MS);
}

export function isOperatorPassPurchaseWithdrawable(
	purchase: OperatorPassPurchaseRow,
	units: ReadonlyArray<OperatorPassUnitRow>,
	receivedAt: Date,
): boolean {
	return (
		UNDELIVERED_WITHDRAWABLE_STATUSES.includes(purchase.status) &&
		purchase.purchased_at != null &&
		purchase.payment_intent_id != null &&
		purchase.perks_granted_at == null &&
		units.length === 0 &&
		isOperatorPassWithinWithdrawalDeadline(purchase, receivedAt)
	);
}

export function listOperatorPassCountryWithdrawableUnits(
	purchase: OperatorPassPurchaseRow,
	units: ReadonlyArray<OperatorPassUnitRow>,
	receivedAt: Date,
): Array<OperatorPassUnitRow> {
	return units.filter((unit) => isOperatorPassUnitWithdrawable(purchase, unit, receivedAt));
}

export function isOperatorPassUnitWithdrawable(
	purchase: OperatorPassPurchaseRow,
	unit: OperatorPassUnitRow,
	receivedAt: Date,
): boolean {
	return (
		WITHDRAWABLE_STATUSES.includes(purchase.status) &&
		unit.status === 'held' &&
		unit.source === 'purchase' &&
		unit.holder_id === purchase.purchaser_id &&
		purchase.withdrawal_days != null &&
		isOperatorPassWithinWithdrawalDeadline(purchase, receivedAt)
	);
}

export function getOperatorPassWithdrawalRightEndsAt(purchase: OperatorPassPurchaseRow): Date | null {
	if (purchase.withdrawal_days != null) {
		return getOperatorPassWithdrawalDeadline(purchase);
	}
	return purchase.perks_granted_at ?? purchase.withdrawal_ends_at ?? null;
}

export function mapOperatorPassPurchaseToResponse(
	purchase: OperatorPassPurchaseRow,
	units: ReadonlyArray<OperatorPassUnitRow>,
	now: Date,
): OperatorPassPurchaseResponse {
	const withdrawable = isOperatorPassPurchaseWithdrawable(purchase, units, now);
	return {
		id: purchase.checkout_session_id,
		status: purchase.status,
		quantity: Math.max(1, purchase.quantity ?? 1),
		amount_minor: purchase.amount_minor,
		currency: purchase.currency as OperatorPassCurrency,
		purchased_at: purchase.purchased_at?.toISOString() ?? null,
		delivered_at: purchase.perks_granted_at?.toISOString() ?? null,
		waiver_consent_at: purchase.waiver_consent_at?.toISOString() ?? null,
		withdrawal_country: purchase.withdrawal_country ?? null,
		withdrawal_ends_at:
			withdrawable || purchase.withdrawal_days != null
				? (getOperatorPassWithdrawalDeadline(purchase)?.toISOString() ?? null)
				: null,
		withdrawal_ends_on:
			purchase.withdrawal_days != null && purchase.withdrawal_ends_at
				? getOperatorPassWithdrawalEndsOn(purchase.withdrawal_ends_at)
				: null,
		withdrawn_at: purchase.withdrawn_at?.toISOString() ?? null,
		has_donation: purchase.subscription_id != null,
		can_withdraw: withdrawable,
	};
}
