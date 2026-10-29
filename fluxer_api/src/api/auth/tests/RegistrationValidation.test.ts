// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAuthHarness, createUniqueEmail, createUniqueUsername} from '@app/api/auth/tests/AuthTestUtils';
import {applySharedListUpdate, resetSharedListsForTests} from '@app/api/infrastructure/activity/SharedLists';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

interface ValidationErrorResponse {
	code: string;
	message: string;
	errors?: Array<{
		path: string;
		code: string;
		message: string;
	}>;
}

describe('Registration validation', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createAuthHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	it('rejects blocked registration email TLDs as invalid email', async () => {
		applySharedListUpdate('email_tld_blocked', 'blocked\n');
		try {
			await createBuilderWithoutAuth(harness)
				.post('/auth/register')
				.body({
					email: 'holdermichael_6023@example.blocked',
					username: createUniqueUsername(),
					global_name: 'Test User',
					password: 'a-strong-password',
					date_of_birth: '2000-01-01',
					consent: true,
				})
				.expect(400)
				.execute();
		} finally {
			resetSharedListsForTests();
		}
	});
	it('defers a missing date of birth to the date of birth step', async () => {
		const registered = await createBuilderWithoutAuth<{token: string}>(harness)
			.post('/auth/register')
			.body({
				email: createUniqueEmail(),
				username: createUniqueUsername(),
				global_name: 'Test User',
				password: 'a-strong-password',
				consent: true,
			})
			.execute();
		const me = await createBuilder<{date_of_birth_required: boolean; traits: Array<string>}>(harness, registered.token)
			.get('/users/@me')
			.execute();
		expect(me.date_of_birth_required).toBe(true);
		expect(me.traits).toContain('dob_deferred');
	});
	it('rejects an impossible calendar date with INVALID_DATE_OF_BIRTH_FORMAT', async () => {
		for (const dateOfBirth of ['2000-02-30', '2000-13-45']) {
			const json = await createBuilderWithoutAuth<ValidationErrorResponse>(harness)
				.post('/auth/register')
				.body({
					email: createUniqueEmail('impossible-dob'),
					username: createUniqueUsername('impossible'),
					global_name: 'Test User',
					password: 'a-strong-password',
					date_of_birth: dateOfBirth,
					consent: true,
				})
				.expect(400, 'INVALID_FORM_BODY')
				.execute();
			const dateOfBirthError = json.errors?.find((e) => e.path === 'date_of_birth');
			expect(dateOfBirthError?.code).toBe('INVALID_DATE_OF_BIRTH_FORMAT');
		}
	});
	it('rejects a real calendar date below the minimum age with MUST_BE_MINIMUM_AGE', async () => {
		const json = await createBuilderWithoutAuth<ValidationErrorResponse>(harness)
			.post('/auth/register')
			.body({
				email: createUniqueEmail('underage'),
				username: createUniqueUsername('underage'),
				global_name: 'Test User',
				password: 'a-strong-password',
				date_of_birth: '2020-01-01',
				consent: true,
			})
			.expect(400, 'INVALID_FORM_BODY')
			.execute();
		const dateOfBirthError = json.errors?.find((e) => e.path === 'date_of_birth');
		expect(dateOfBirthError?.code).toBe('MUST_BE_MINIMUM_AGE');
	});
});
