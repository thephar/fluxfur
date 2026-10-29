// SPDX-License-Identifier: AGPL-3.0-or-later

import {getProtectedLocalStorage} from '@app/features/platform/state/ProtectedWebStorage';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {MS_PER_DAY} from '@fluxer/date_utils/src/DateConstants';

const logger = new Logger('AccountEntryStorage');

const DEVICE_PROOF_KEY_PREFIX = 'fluxer.device_proof.';
const AGE_BLOCK_KEY = 'fluxer.age_block_until';

function readItem(key: string): string | null {
	try {
		return getProtectedLocalStorage()?.getItem(key) ?? null;
	} catch (error) {
		logger.warn('Failed to read account entry storage', error);
		return null;
	}
}

function writeItem(key: string, value: string): void {
	try {
		getProtectedLocalStorage()?.setItem(key, value);
	} catch (error) {
		logger.warn('Failed to write account entry storage', error);
	}
}

export function readDeviceProof(userId: string): string | null {
	return readItem(`${DEVICE_PROOF_KEY_PREFIX}${userId}`);
}

export function storeDeviceProof(userId: string, deviceProof: string | undefined): void {
	if (deviceProof === undefined || deviceProof === '') {
		return;
	}
	writeItem(`${DEVICE_PROOF_KEY_PREFIX}${userId}`, deviceProof);
}

export function isAgeBlocked(): boolean {
	const now = Date.now();
	const until = Number(readItem(AGE_BLOCK_KEY));
	return Number.isFinite(until) && until > now;
}

let ageBlockedAccountRemoved = false;

export function markAgeBlocked(options: {accountRemoved?: boolean} = {}): void {
	const now = Date.now();
	writeItem(AGE_BLOCK_KEY, String(now + MS_PER_DAY));
	ageBlockedAccountRemoved = options.accountRemoved === true;
}

export function takeAgeBlockedAccountRemoved(): boolean {
	const removed = ageBlockedAccountRemoved;
	ageBlockedAccountRemoved = false;
	return removed;
}
