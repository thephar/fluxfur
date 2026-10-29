// SPDX-License-Identifier: AGPL-3.0-or-later

import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {AssetDeletionQueue} from '@app/api/infrastructure/AssetDeletionQueue';
import {NoopPurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {MockStorageService} from '@app/api/test/mocks/MockStorageService';
import {createTestWorkerHelpers} from '@app/api/test/SyncTaskWorkerService';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import processAssetDeletionQueue from '@app/api/worker/tasks/ProcessAssetDeletionQueue';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, describe, expect, it} from 'vitest';

function createHarness(storageService: MockStorageService) {
	const kvClient = new MockKVProvider();
	const assetDeletionQueue = new AssetDeletionQueue(kvClient);
	setWorkerDependenciesForTest({
		assetDeletionQueue,
		purgeQueue: new NoopPurgeQueue(),
		storageService,
		userRepository: new UserRepository(kvClient),
		guildRepository: new GuildRepository(),
	});
	return {assetDeletionQueue};
}

async function queueAssets(assetDeletionQueue: AssetDeletionQueue, count: number): Promise<void> {
	for (let index = 0; index < count; index++) {
		await assetDeletionQueue.queueDeletion({
			s3Key: `attachments/100/200/file-${index}.png`,
			cdnUrl: null,
			reason: 'test',
		});
	}
}

describe('processAssetDeletionQueue', () => {
	afterEach(() => {
		clearWorkerDependencies();
	});

	it('attempts each queued asset once per run when storage is failing', async () => {
		const {assetDeletionQueue} = createHarness(new MockStorageService({shouldFailDelete: true}));
		await queueAssets(assetDeletionQueue, 3);

		await expect(processAssetDeletionQueue({}, createTestWorkerHelpers())).rejects.toThrow(/3 failures/);

		const remaining = await assetDeletionQueue.getBatch(10);
		expect(remaining.map((item) => item.retryCount)).toEqual([1, 1, 1]);
	});

	it('attempts each queued asset once per run across batch boundaries', async () => {
		const {assetDeletionQueue} = createHarness(new MockStorageService({shouldFailDelete: true}));
		await queueAssets(assetDeletionQueue, 60);

		await expect(processAssetDeletionQueue({}, createTestWorkerHelpers())).rejects.toThrow(/60 failures/);

		const remaining = await assetDeletionQueue.getBatch(100);
		expect(remaining).toHaveLength(60);
		expect(remaining.every((item) => item.retryCount === 1)).toBe(true);
	});

	it('drains the queue when storage succeeds', async () => {
		const {assetDeletionQueue} = createHarness(new MockStorageService());
		await queueAssets(assetDeletionQueue, 60);

		await processAssetDeletionQueue({}, createTestWorkerHelpers());

		expect(await assetDeletionQueue.getQueueSize()).toBe(0);
	});
});
