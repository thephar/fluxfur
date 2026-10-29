// SPDX-License-Identifier: AGPL-3.0-or-later

import {SsoIdentityRepository} from '@app/api/auth/services/SsoIdentityRepository';
import {createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const ALICE = createUserID(1810000000000000001n);
const BOB = createUserID(1810000000000000002n);

describe('SsoIdentityRepository', () => {
	const repository = new SsoIdentityRepository();

	beforeEach(async () => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		const claimedAt = new Date('2026-10-01T00:00:00Z');
		await repository.tryClaimIdentity({providerId: 'https://idp.one', subject: 'alice', userId: ALICE, claimedAt});
		await repository.tryClaimIdentity({providerId: 'https://idp.one', subject: 'bob', userId: BOB, claimedAt});
		await repository.tryClaimIdentity({providerId: 'https://idp.two', subject: 'alice-2', userId: ALICE, claimedAt});
	});

	afterEach(() => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});

	it('releases the identities of one account and leaves the others', async () => {
		expect(await repository.releaseIdentitiesForUser(ALICE)).toBe(2);
		expect(await repository.findUserId('https://idp.one', 'alice')).toBeNull();
		expect(await repository.findUserId('https://idp.two', 'alice-2')).toBeNull();
		expect(await repository.findUserId('https://idp.one', 'bob')).toBe(BOB);
		expect(await repository.listForUser(ALICE)).toEqual([]);
		expect((await repository.listForUser(BOB)).map(({subject}) => subject)).toEqual(['bob']);
	});

	it('skips an index entry whose identity now belongs to another account', async () => {
		await repository.releaseIdentity('https://idp.one', 'alice');
		await repository.tryClaimIdentity({
			providerId: 'https://idp.one',
			subject: 'alice',
			userId: BOB,
			claimedAt: new Date(),
		});
		expect((await repository.listForUser(ALICE)).map(({subject}) => subject)).toEqual(['alice-2']);
		expect(await repository.releaseIdentitiesForUser(ALICE)).toBe(1);
		expect(await repository.findUserId('https://idp.one', 'alice')).toBe(BOB);
	});
});
