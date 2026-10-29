// SPDX-License-Identifier: AGPL-3.0-or-later

import {getProtectedSessionStorage} from '@app/features/platform/state/ProtectedWebStorage';
import OperatorPassHoldings from '@app/features/premium/state/OperatorPassHoldings';
import PremiumState from '@app/features/premium/state/PremiumState';
import Users from '@app/features/user/state/Users';
import {isRecord} from '@fluxer/record_utils/src/RecordGuards';
import type {OperatorPassStateResponse} from '@fluxer/schema/src/domains/operator_pass/OperatorPassSchemas';

const STORAGE_KEY = 'PremiumCheckoutReturnIntent';
const INTENT_TTL_MS = 30 * 60 * 1000;

export type PremiumCheckoutReturnSource = 'plutonium' | 'operator_pass';

interface PremiumCheckoutReturnIntent {
	id: string;
	source: PremiumCheckoutReturnSource;
	userId: string | null;
	createdAt: number;
	expiresAt: number;
	startedComplete: boolean;
	startedPassCount: number;
}

function getStorage(): Storage | null {
	return getProtectedSessionStorage();
}

function generateIntentId(): string {
	return `premium-checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parsePremiumCheckoutReturnIntent(raw: string): PremiumCheckoutReturnIntent | null {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		return null;
	}
	if (
		typeof parsed.id !== 'string' ||
		(parsed.source !== 'plutonium' && parsed.source !== 'operator_pass') ||
		(typeof parsed.userId !== 'string' && parsed.userId !== null) ||
		typeof parsed.createdAt !== 'number' ||
		typeof parsed.expiresAt !== 'number' ||
		typeof parsed.startedComplete !== 'boolean' ||
		typeof parsed.startedPassCount !== 'number'
	) {
		return null;
	}
	return {
		id: parsed.id,
		source: parsed.source,
		userId: parsed.userId,
		createdAt: parsed.createdAt,
		expiresAt: parsed.expiresAt,
		startedComplete: parsed.startedComplete,
		startedPassCount: parsed.startedPassCount,
	};
}

export function getCurrentPremiumActive(): boolean {
	const currentUser = Users.currentUser;
	if (!currentUser) return false;
	const premiumState = PremiumState.loadedForUserId === currentUser.id ? PremiumState.state : null;
	return premiumState?.effective.is_premium ?? currentUser.isPremium();
}

export function getCurrentOperatorPassCount(): number {
	return OperatorPassHoldings.count ?? (Users.currentUser?.operatorPassSince != null ? 1 : 0);
}

function isCheckoutReturnComplete(source: PremiumCheckoutReturnSource, startedPassCount: number): boolean {
	return source === 'operator_pass' ? getCurrentOperatorPassCount() > startedPassCount : getCurrentPremiumActive();
}

function readIntent(): PremiumCheckoutReturnIntent | null {
	const storage = getStorage();
	if (!storage) return null;
	const raw = storage.getItem(STORAGE_KEY);
	if (!raw) return null;
	try {
		const parsed = parsePremiumCheckoutReturnIntent(raw);
		if (!parsed) {
			storage.removeItem(STORAGE_KEY);
			return null;
		}
		if (Date.now() > parsed.expiresAt) {
			storage.removeItem(STORAGE_KEY);
			return null;
		}
		return parsed as PremiumCheckoutReturnIntent;
	} catch {
		storage.removeItem(STORAGE_KEY);
		return null;
	}
}

export function recordPremiumCheckoutReturnIntent(
	source: PremiumCheckoutReturnSource,
	options: {passCount?: number} = {},
): void {
	const storage = getStorage();
	if (!storage) return;
	const currentUser = Users.currentUser;
	const startedPassCount = options.passCount ?? getCurrentOperatorPassCount();
	const startedComplete = source === 'plutonium' && getCurrentPremiumActive();
	if (startedComplete) {
		storage.removeItem(STORAGE_KEY);
		return;
	}
	const now = Date.now();
	const intent: PremiumCheckoutReturnIntent = {
		id: generateIntentId(),
		source,
		userId: currentUser?.id ?? null,
		createdAt: now,
		expiresAt: now + INTENT_TTL_MS,
		startedComplete,
		startedPassCount,
	};
	storage.setItem(STORAGE_KEY, JSON.stringify(intent));
}

export function getPendingPremiumCheckoutReturnIntent(): PremiumCheckoutReturnIntent | null {
	const intent = readIntent();
	if (!intent || intent.startedComplete) return null;
	const currentUserId = Users.currentUser?.id ?? null;
	if (intent.userId && intent.userId !== currentUserId) {
		clearPremiumCheckoutReturnIntent();
		return null;
	}
	return intent;
}

export function consumeCompletedPremiumCheckoutReturnIntent(): PremiumCheckoutReturnIntent | null {
	const intent = getPendingPremiumCheckoutReturnIntent();
	if (!intent || !isCheckoutReturnComplete(intent.source, intent.startedPassCount)) return null;
	clearPremiumCheckoutReturnIntent();
	return intent;
}

export function consumeOperatorPassCheckoutReturnIntent(state: OperatorPassStateResponse): boolean {
	const intent = getPendingPremiumCheckoutReturnIntent();
	if (intent?.source !== 'operator_pass') return false;
	if ((state.holder?.count ?? 0) <= intent.startedPassCount) return false;
	clearPremiumCheckoutReturnIntent();
	return true;
}

function clearPremiumCheckoutReturnIntent(): void {
	getStorage()?.removeItem(STORAGE_KEY);
}
