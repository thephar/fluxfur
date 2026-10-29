// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {
	BatchBuilder,
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchOne,
	fetchPage,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db, type DbOp, nextVersion, type PatchObject} from '@app/api/database/CassandraTypes';
import {applyPatchToRow} from '@app/api/database/CassandraVersionedUpdate';
import type {
	OperatorPassOfferRow,
	OperatorPassPurchaseByPaymentIntentRow,
	OperatorPassPurchaseByPurchaserRow,
	OperatorPassPurchaseRow,
	OperatorPassReleaseRow,
	OperatorPassRemovalEndReason,
	OperatorPassRemovalHistoryRow,
	OperatorPassRemovalRow,
	OperatorPassRow,
	OperatorPassUnitEventRow,
	OperatorPassUnitRow,
	OperatorPassWaitlistByEntryIdRow,
	OperatorPassWaitlistRow,
	OperatorPassWallDecisionRow,
	OperatorPassWallEntryRow,
	OperatorPassWallEventRow,
	OperatorPassWallRevisionRow,
	OperatorPassWallStateRow,
	OperatorPassWallTombstoneRow,
} from '@app/api/database/types/OperatorPassTypes';
import {OPERATOR_PASS_WAITLIST_COLUMNS} from '@app/api/database/types/OperatorPassTypes';
import {
	OperatorPasses,
	OperatorPassOffers,
	OperatorPassOffersByUser,
	OperatorPassPurchases,
	OperatorPassPurchasesByPaymentIntent,
	OperatorPassPurchasesByPurchaser,
	OperatorPassReleases,
	OperatorPassRemovalHistory,
	OperatorPassRemovals,
	OperatorPassUnitEvents,
	OperatorPassUnits,
	OperatorPassUnitsByHolder,
	OperatorPassUnitsByPurchase,
	OperatorPassWaitlist,
	OperatorPassWaitlistByEntryId,
	OperatorPassWallAuditLogs,
	OperatorPassWallAvatarRefs,
	OperatorPassWallDecisions,
	OperatorPassWallEntries,
	OperatorPassWallEvents,
	OperatorPassWallPending,
	OperatorPassWallRevisions,
	OperatorPassWallState,
	OperatorPassWallTombstones,
} from '@app/api/operator_pass/OperatorPassTables';
import {compareSnowflakes} from '@fluxer/snowflake/src/SnowflakeComparison';
import {BACKGROUND_READ_TIMEOUT_MS} from '@pkgs/cassandra/src/Client';

type RowPatch<Row, PK extends keyof Row> = Partial<{
	[K in Exclude<keyof Row, PK | 'version'>]: DbOp<Row[K]>;
}>;

export type OperatorPassWaitlistPatch = RowPatch<OperatorPassWaitlistRow, 'email'>;
export type OperatorPassPurchasePatch = RowPatch<OperatorPassPurchaseRow, 'checkout_session_id'>;
export type OperatorPassUnitPatch = RowPatch<OperatorPassUnitRow, 'pass_id'>;
export type OperatorPassOfferPatch = RowPatch<OperatorPassOfferRow, 'offer_id'>;
export type OperatorPassWallEntryPatch = RowPatch<OperatorPassWallEntryRow, 'user_id'>;

export interface OperatorPassScanPage<Row> {
	rows: Array<Row>;
	pageState: string | null;
}

export interface OperatorPassWaitlistPage {
	entries: Array<OperatorPassWaitlistRow>;
	pageState: string | null;
}

const FETCH_WAITLIST_BY_EMAIL = OperatorPassWaitlist.selectCql({
	where: OperatorPassWaitlist.where.eq('email'),
	limit: 1,
});
const FETCH_WAITLIST_EMAIL_BY_ENTRY_ID = OperatorPassWaitlistByEntryId.selectCql({
	where: OperatorPassWaitlistByEntryId.where.eq('entry_id'),
	limit: 1,
});
const SCAN_WAITLIST = OperatorPassWaitlist.selectCql();
const FETCH_PASS_BY_USER = OperatorPasses.selectCql({
	where: OperatorPasses.where.eq('user_id'),
	limit: 1,
});
const FETCH_PURCHASE = OperatorPassPurchases.selectCql({
	where: OperatorPassPurchases.where.eq('checkout_session_id'),
	limit: 1,
});
const FETCH_PURCHASE_BY_PAYMENT_INTENT = OperatorPassPurchasesByPaymentIntent.selectCql({
	where: OperatorPassPurchasesByPaymentIntent.where.eq('payment_intent_id'),
	limit: 1,
});
const FETCH_PURCHASE_IDS_BY_PURCHASER = OperatorPassPurchasesByPurchaser.selectCql({
	columns: ['checkout_session_id'],
	where: OperatorPassPurchasesByPurchaser.where.eq('purchaser_id'),
});
const FETCH_REMOVAL = OperatorPassRemovals.selectCql({
	where: OperatorPassRemovals.where.eq('user_id'),
	limit: 1,
});
const SCAN_REMOVALS = OperatorPassRemovals.selectCql();
const FETCH_REMOVAL_HISTORY = OperatorPassRemovalHistory.selectCql({
	where: OperatorPassRemovalHistory.where.eq('user_id'),
});

const FETCH_WALL_ENTRY = OperatorPassWallEntries.selectCql({
	where: OperatorPassWallEntries.where.eq('user_id'),
	limit: 1,
});
const SCAN_WALL_ENTRIES = OperatorPassWallEntries.selectCql();
const FETCH_WALL_EVENTS = OperatorPassWallEvents.selectCql({
	where: OperatorPassWallEvents.where.eq('user_id'),
});
const FETCH_WALL_REVISIONS = OperatorPassWallRevisions.selectCql({
	where: OperatorPassWallRevisions.where.eq('user_id'),
});
const FETCH_WALL_DECISIONS = OperatorPassWallDecisions.selectCql({
	where: OperatorPassWallDecisions.where.eq('user_id'),
});
const FETCH_WALL_AUDIT_LOGS = OperatorPassWallAuditLogs.selectCql({
	where: OperatorPassWallAuditLogs.where.eq('user_id'),
});
const FETCH_WALL_AVATAR_REFS = OperatorPassWallAvatarRefs.selectCql({
	where: OperatorPassWallAvatarRefs.where.eq('avatar'),
});
const FETCH_WALL_PENDING = OperatorPassWallPending.selectCql({
	where: OperatorPassWallPending.where.eq('bucket'),
});
const WALL_PENDING_BUCKET = 'pending';
const SCAN_WALL_TOMBSTONES = OperatorPassWallTombstones.selectCql();
const FETCH_WALL_STATE = OperatorPassWallState.selectCql({
	where: OperatorPassWallState.where.eq('id'),
});
const FETCH_RELEASE = OperatorPassReleases.selectCql({
	where: OperatorPassReleases.where.eq('year'),
	limit: 1,
});
const SCAN_RELEASES = OperatorPassReleases.selectCql();

const FETCH_UNIT = OperatorPassUnits.selectCql({where: OperatorPassUnits.where.eq('pass_id'), limit: 1});
const FETCH_UNIT_IDS_BY_HOLDER = OperatorPassUnitsByHolder.selectCql({
	columns: ['pass_id'],
	where: OperatorPassUnitsByHolder.where.eq('holder_id'),
});
const FETCH_UNIT_IDS_BY_PURCHASE = OperatorPassUnitsByPurchase.selectCql({
	columns: ['pass_id'],
	where: OperatorPassUnitsByPurchase.where.eq('purchase_id'),
});
const FETCH_OFFER = OperatorPassOffers.selectCql({where: OperatorPassOffers.where.eq('offer_id'), limit: 1});
const SCAN_OFFERS = OperatorPassOffers.selectCql();
const FETCH_OFFER_IDS_BY_USER = OperatorPassOffersByUser.selectCql({
	columns: ['offer_id'],
	where: OperatorPassOffersByUser.where.eq('user_id'),
});
const FETCH_UNIT_EVENTS = OperatorPassUnitEvents.selectCql({where: OperatorPassUnitEvents.where.eq('pass_id')});

function withPatch<Row extends {version: number}>(current: Row, patch: object, version: number): Row {
	return {...applyPatchToRow<Row>(current, patch as PatchObject), version} as Row;
}

export class OperatorPassRepository {
	async findWaitlistEntryByEmail(email: string): Promise<OperatorPassWaitlistRow | null> {
		return fetchOne<OperatorPassWaitlistRow>(FETCH_WAITLIST_BY_EMAIL, {email});
	}

	async findWaitlistEntryByEntryId(entryId: string): Promise<OperatorPassWaitlistRow | null> {
		const mapping = await fetchOne<OperatorPassWaitlistByEntryIdRow>(FETCH_WAITLIST_EMAIL_BY_ENTRY_ID, {
			entry_id: entryId,
		});
		if (!mapping) {
			return null;
		}
		const entry = await this.findWaitlistEntryByEmail(mapping.email);
		return entry?.entry_id === entryId ? entry : null;
	}

	async saveWaitlistEntry(
		entry: OperatorPassWaitlistRow,
		previous: OperatorPassWaitlistRow | null = null,
	): Promise<boolean> {
		const applied = previous
			? await executeConditional(
					OperatorPassWaitlist.conditionalPatchByPk(
						{email: entry.email},
						waitlistRowPatch(entry),
						expectedWaitlistVersion(previous),
					),
				)
			: await executeConditional(OperatorPassWaitlist.insertIfNotExists(entry));
		if (!applied) return false;
		await upsertOne(OperatorPassWaitlistByEntryId.upsertAll({entry_id: entry.entry_id, email: entry.email}));
		if (previous && previous.entry_id !== entry.entry_id) {
			await deleteOneOrMany(OperatorPassWaitlistByEntryId.deleteByPk({entry_id: previous.entry_id}));
		}
		return true;
	}

	async probeWaitlistEntry(email: string, entryId: string): Promise<void> {
		await executeConditional(
			OperatorPassWaitlist.conditionalPatchByPk({email}, {updated_at: Db.set(new Date(0))}, {version: 0}),
		);
		await fetchOne<OperatorPassWaitlistByEntryIdRow>(FETCH_WAITLIST_EMAIL_BY_ENTRY_ID, {entry_id: entryId});
	}

	async updateWaitlistEntry(
		current: OperatorPassWaitlistRow,
		patch: OperatorPassWaitlistPatch,
	): Promise<OperatorPassWaitlistRow | null> {
		const version = nextVersion(current.version);
		const applied = await executeConditional(
			OperatorPassWaitlist.conditionalPatchByPk(
				{email: current.email},
				{...patch, version: Db.set(version)},
				expectedWaitlistVersion(current),
			),
		);
		return applied ? withPatch(current, patch, version) : null;
	}

	async deleteWaitlistEntry(entry: OperatorPassWaitlistRow): Promise<boolean> {
		const applied = await executeConditional(
			OperatorPassWaitlist.conditionalDeleteByPk({email: entry.email}, expectedWaitlistVersion(entry)),
		);
		if (applied) await deleteOneOrMany(OperatorPassWaitlistByEntryId.deleteByPk({entry_id: entry.entry_id}));
		return applied;
	}

	async markWaitlistSaleEmailSent(email: string, sentAt: Date): Promise<boolean> {
		return executeConditional(
			OperatorPassWaitlist.conditionalPatchByPk({email}, {sale_email_sent_at: Db.set(sentAt)}, {status: 'confirmed'}),
		);
	}

	async scanWaitlistPage(pageSize: number, pageState?: string | null): Promise<OperatorPassWaitlistPage> {
		const page = await fetchPage<OperatorPassWaitlistRow>(
			SCAN_WAITLIST,
			{},
			{pageSize, pageState, readTimeout: BACKGROUND_READ_TIMEOUT_MS},
		);
		return {entries: page.rows, pageState: page.pageState};
	}

	async findOperatorPass(userId: UserID): Promise<OperatorPassRow | null> {
		return fetchOne<OperatorPassRow>(FETCH_PASS_BY_USER, {user_id: userId});
	}

	async deleteOperatorPass(userId: UserID): Promise<boolean> {
		const current = await this.findOperatorPass(userId);
		if (!current) {
			return false;
		}
		return executeConditional(OperatorPasses.conditionalDeleteByPk({user_id: userId}, {version: current.version}));
	}

	async createPurchase(purchase: OperatorPassPurchaseRow): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(OperatorPassPurchases.upsertAll(purchase));
		batch.addPrepared(
			OperatorPassPurchasesByPurchaser.upsertAll({
				purchaser_id: purchase.purchaser_id,
				checkout_session_id: purchase.checkout_session_id,
			}),
		);
		if (purchase.payment_intent_id) {
			batch.addPrepared(
				OperatorPassPurchasesByPaymentIntent.upsertAll({
					payment_intent_id: purchase.payment_intent_id,
					checkout_session_id: purchase.checkout_session_id,
				}),
			);
		}
		await batch.execute();
	}

	async deletePurchase(
		purchase: Pick<OperatorPassPurchaseRow, 'checkout_session_id' | 'purchaser_id' | 'payment_intent_id'>,
	): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(OperatorPassPurchases.deleteByPk({checkout_session_id: purchase.checkout_session_id}));
		batch.addPrepared(
			OperatorPassPurchasesByPurchaser.deleteByPk({
				purchaser_id: purchase.purchaser_id,
				checkout_session_id: purchase.checkout_session_id,
			}),
		);
		if (purchase.payment_intent_id) {
			batch.addPrepared(
				OperatorPassPurchasesByPaymentIntent.deleteByPk({payment_intent_id: purchase.payment_intent_id}),
			);
		}
		await batch.execute();
	}

	async findPurchase(checkoutSessionId: string): Promise<OperatorPassPurchaseRow | null> {
		return fetchOne<OperatorPassPurchaseRow>(FETCH_PURCHASE, {checkout_session_id: checkoutSessionId});
	}

	async listPurchasesByPurchaser(purchaserId: UserID): Promise<Array<OperatorPassPurchaseRow>> {
		const mappings = await fetchMany<Pick<OperatorPassPurchaseByPurchaserRow, 'checkout_session_id'>>(
			FETCH_PURCHASE_IDS_BY_PURCHASER,
			{purchaser_id: purchaserId},
		);
		const purchases = await Promise.all(mappings.map((mapping) => this.findPurchase(mapping.checkout_session_id)));
		return purchases.filter((purchase): purchase is OperatorPassPurchaseRow => purchase !== null);
	}

	async findPurchaseByPaymentIntent(paymentIntentId: string): Promise<OperatorPassPurchaseRow | null> {
		const mapping = await fetchOne<OperatorPassPurchaseByPaymentIntentRow>(FETCH_PURCHASE_BY_PAYMENT_INTENT, {
			payment_intent_id: paymentIntentId,
		});
		if (!mapping) {
			return null;
		}
		return this.findPurchase(mapping.checkout_session_id);
	}

	async updatePurchase(
		current: OperatorPassPurchaseRow,
		patch: OperatorPassPurchasePatch,
	): Promise<OperatorPassPurchaseRow> {
		const version = nextVersion(current.version);
		const batch = new BatchBuilder();
		batch.addPrepared(
			OperatorPassPurchases.patchByPk(
				{checkout_session_id: current.checkout_session_id},
				{...patch, version: Db.set(version)},
			),
		);
		const paymentIntent = patch.payment_intent_id;
		if (paymentIntent?.kind === 'set' && paymentIntent.value) {
			batch.addPrepared(
				OperatorPassPurchasesByPaymentIntent.upsertAll({
					payment_intent_id: paymentIntent.value,
					checkout_session_id: current.checkout_session_id,
				}),
			);
		}
		await batch.execute();
		return withPatch(current, patch, version);
	}

	async findRemoval(userId: UserID): Promise<OperatorPassRemovalRow | null> {
		return fetchOne<OperatorPassRemovalRow>(FETCH_REMOVAL, {user_id: userId});
	}

	async saveRemoval(row: OperatorPassRemovalRow): Promise<void> {
		await upsertOne(OperatorPassRemovals.upsertAll(row));
	}

	async deleteRemoval(userId: UserID): Promise<void> {
		await deleteOneOrMany(OperatorPassRemovals.deleteByPk({user_id: userId}));
	}

	async scanRemovals(
		pageSize: number,
		pageState?: string | null,
	): Promise<OperatorPassScanPage<OperatorPassRemovalRow>> {
		const page = await fetchPage<OperatorPassRemovalRow>(
			SCAN_REMOVALS,
			{},
			{pageSize, pageState, readTimeout: BACKGROUND_READ_TIMEOUT_MS},
		);
		return {rows: page.rows, pageState: page.pageState};
	}

	async saveRemovalHistory(row: OperatorPassRemovalHistoryRow): Promise<void> {
		await upsertOne(OperatorPassRemovalHistory.upsertAll(row));
	}

	async endRemovalHistory(
		userId: UserID,
		removedAt: Date,
		endedAt: Date,
		reason: OperatorPassRemovalEndReason,
	): Promise<void> {
		await upsertOne(
			OperatorPassRemovalHistory.patchByPk(
				{user_id: userId, removed_at: removedAt},
				{ended_at: Db.set(endedAt), end_reason: Db.set(reason)},
			),
		);
	}

	async listRemovalHistory(userId: UserID): Promise<Array<OperatorPassRemovalHistoryRow>> {
		const rows = await fetchMany<OperatorPassRemovalHistoryRow>(FETCH_REMOVAL_HISTORY, {user_id: userId});
		return rows.sort((left, right) => left.removed_at.getTime() - right.removed_at.getTime());
	}

	async findWallEntry(userId: UserID): Promise<OperatorPassWallEntryRow | null> {
		return fetchOne<OperatorPassWallEntryRow>(FETCH_WALL_ENTRY, {user_id: userId});
	}

	async createWallEntry(entry: OperatorPassWallEntryRow): Promise<boolean> {
		return executeConditional(OperatorPassWallEntries.insertIfNotExists(entry));
	}

	async updateWallEntry(
		current: OperatorPassWallEntryRow,
		patch: OperatorPassWallEntryPatch,
	): Promise<OperatorPassWallEntryRow | null> {
		const version = nextVersion(current.version);
		const applied = await executeConditional(
			OperatorPassWallEntries.conditionalPatchByPk(
				{user_id: current.user_id},
				{...patch, version: Db.set(version)},
				{version: current.version},
			),
		);
		return applied ? withPatch(current, patch, version) : null;
	}

	async scanWallEntries(
		pageSize: number,
		pageState?: string | null,
	): Promise<OperatorPassScanPage<OperatorPassWallEntryRow>> {
		const page = await fetchPage<OperatorPassWallEntryRow>(
			SCAN_WALL_ENTRIES,
			{},
			{pageSize, pageState, readTimeout: BACKGROUND_READ_TIMEOUT_MS},
		);
		return {rows: page.rows, pageState: page.pageState};
	}

	async appendWallEvent(row: OperatorPassWallEventRow): Promise<void> {
		await upsertOne(OperatorPassWallEvents.upsertAll(row));
	}

	async listWallEvents(userId: UserID): Promise<Array<OperatorPassWallEventRow>> {
		const rows = await fetchMany<OperatorPassWallEventRow>(FETCH_WALL_EVENTS, {user_id: userId});
		return rows.sort(
			(left, right) =>
				left.occurred_at.getTime() - right.occurred_at.getTime() || left.event_id.localeCompare(right.event_id),
		);
	}

	async appendWallRevision(row: OperatorPassWallRevisionRow): Promise<boolean> {
		return executeConditional(OperatorPassWallRevisions.insertIfNotExists(row));
	}

	async listWallRevisions(userId: UserID): Promise<Array<OperatorPassWallRevisionRow>> {
		const rows = await fetchMany<OperatorPassWallRevisionRow>(FETCH_WALL_REVISIONS, {user_id: userId});
		return rows.sort((left, right) => compareSnowflakes(left.revision_id, right.revision_id));
	}

	async appendWallDecision(row: OperatorPassWallDecisionRow): Promise<boolean> {
		return executeConditional(OperatorPassWallDecisions.insertIfNotExists(row));
	}

	async listWallDecisions(userId: UserID): Promise<Array<OperatorPassWallDecisionRow>> {
		const rows = await fetchMany<OperatorPassWallDecisionRow>(FETCH_WALL_DECISIONS, {user_id: userId});
		return rows.sort((left, right) => compareSnowflakes(left.decision_id, right.decision_id));
	}

	async saveWallRevision(row: OperatorPassWallRevisionRow): Promise<void> {
		await upsertOne(OperatorPassWallRevisions.upsertAll(row));
	}

	async saveWallDecision(row: OperatorPassWallDecisionRow): Promise<void> {
		await upsertOne(OperatorPassWallDecisions.upsertAll(row));
	}

	async addWallAvatarRef(avatar: string, userId: UserID): Promise<void> {
		await upsertOne(OperatorPassWallAvatarRefs.upsertAll({avatar, user_id: userId}));
	}

	async removeWallAvatarRef(avatar: string, userId: UserID): Promise<void> {
		await deleteOneOrMany(OperatorPassWallAvatarRefs.deleteByPk({avatar, user_id: userId}));
	}

	async listWallAvatarRefs(avatar: string): Promise<Array<UserID>> {
		const rows = await fetchMany<{user_id: UserID}>(FETCH_WALL_AVATAR_REFS, {avatar});
		return rows.map((row) => row.user_id);
	}

	async setWallPending(userId: UserID, pending: boolean): Promise<void> {
		if (pending) {
			await upsertOne(OperatorPassWallPending.upsertAll({bucket: WALL_PENDING_BUCKET, user_id: userId}));
		} else {
			await deleteOneOrMany(OperatorPassWallPending.deleteByPk({bucket: WALL_PENDING_BUCKET, user_id: userId}));
		}
	}

	async listWallPending(): Promise<Array<UserID>> {
		const rows = await fetchMany<{user_id: UserID}>(FETCH_WALL_PENDING, {bucket: WALL_PENDING_BUCKET});
		return rows.map((row) => row.user_id);
	}

	async addWallAuditLog(userId: UserID, logId: bigint): Promise<void> {
		await upsertOne(OperatorPassWallAuditLogs.upsertAll({user_id: userId, log_id: logId}));
	}

	async listWallAuditLogIds(userId: UserID): Promise<Array<bigint>> {
		const rows = await fetchMany<{log_id: bigint}>(FETCH_WALL_AUDIT_LOGS, {user_id: userId});
		return rows.map((row) => row.log_id);
	}

	async deleteWallPartitions(userId: UserID): Promise<void> {
		await deleteOneOrMany(OperatorPassWallAuditLogs.deletePartition({user_id: userId}));
		await deleteOneOrMany(OperatorPassWallRevisions.deletePartition({user_id: userId}));
		await deleteOneOrMany(OperatorPassWallDecisions.deletePartition({user_id: userId}));
		await deleteOneOrMany(OperatorPassWallEvents.deletePartition({user_id: userId}));
		await deleteOneOrMany(OperatorPassWallEntries.deleteByPk({user_id: userId}));
	}

	async saveWallTombstone(row: OperatorPassWallTombstoneRow): Promise<void> {
		await upsertOne(OperatorPassWallTombstones.upsertAll(row));
	}

	async listWallTombstones(): Promise<Array<OperatorPassWallTombstoneRow>> {
		return fetchMany<OperatorPassWallTombstoneRow>(SCAN_WALL_TOMBSTONES, {});
	}

	async findWallState(id: string): Promise<OperatorPassWallStateRow | null> {
		return fetchOne<OperatorPassWallStateRow>(FETCH_WALL_STATE, {id});
	}

	async createWallState(row: OperatorPassWallStateRow): Promise<boolean> {
		return executeConditional(OperatorPassWallState.insertIfNotExists(row));
	}

	async updateWallState(
		current: OperatorPassWallStateRow,
		patch: RowPatch<OperatorPassWallStateRow, 'id'>,
	): Promise<OperatorPassWallStateRow | null> {
		const version = nextVersion(current.version);
		const applied = await executeConditional(
			OperatorPassWallState.conditionalPatchByPk(
				{id: current.id},
				{...patch, version: Db.set(version)},
				{version: current.version},
			),
		);
		return applied ? withPatch(current, patch, version) : null;
	}

	async findRelease(year: number): Promise<OperatorPassReleaseRow | null> {
		return fetchOne<OperatorPassReleaseRow>(FETCH_RELEASE, {year});
	}

	async createRelease(row: OperatorPassReleaseRow): Promise<boolean> {
		return executeConditional(OperatorPassReleases.insertIfNotExists(row));
	}

	async saveRelease(row: OperatorPassReleaseRow): Promise<void> {
		await upsertOne(OperatorPassReleases.upsertAll(row));
	}

	async listReleases(): Promise<Array<OperatorPassReleaseRow>> {
		const rows = await fetchMany<OperatorPassReleaseRow>(SCAN_RELEASES, {});
		return rows.sort((left, right) => left.year - right.year);
	}

	async createUnit(unit: OperatorPassUnitRow): Promise<boolean> {
		const created = await executeConditional(OperatorPassUnits.insertIfNotExists(unit));
		if (created) {
			const batch = new BatchBuilder();
			batch.addPrepared(OperatorPassUnitsByHolder.upsertAll({holder_id: unit.holder_id, pass_id: unit.pass_id}));
			if (unit.purchase_id) {
				batch.addPrepared(
					OperatorPassUnitsByPurchase.upsertAll({purchase_id: unit.purchase_id, pass_id: unit.pass_id}),
				);
			}
			await batch.execute();
		}
		return created;
	}

	async findUnit(passId: string): Promise<OperatorPassUnitRow | null> {
		return fetchOne<OperatorPassUnitRow>(FETCH_UNIT, {pass_id: passId});
	}

	async updateUnit(current: OperatorPassUnitRow, patch: OperatorPassUnitPatch): Promise<OperatorPassUnitRow | null> {
		const version = nextVersion(current.version);
		const applied = await executeConditional(
			OperatorPassUnits.conditionalPatchByPk(
				{pass_id: current.pass_id},
				{...patch, version: Db.set(version)},
				{version: current.version},
			),
		);
		return applied ? withPatch(current, patch, version) : null;
	}

	async moveUnitHolder(passId: string, from: UserID, to: UserID): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(OperatorPassUnitsByHolder.deleteByPk({holder_id: from, pass_id: passId}));
		batch.addPrepared(OperatorPassUnitsByHolder.upsertAll({holder_id: to, pass_id: passId}));
		await batch.execute();
	}

	async removeUnitFromHolder(passId: string, holderId: UserID): Promise<void> {
		await deleteOneOrMany(OperatorPassUnitsByHolder.deleteByPk({holder_id: holderId, pass_id: passId}));
	}

	async listUnitsByHolder(holderId: UserID): Promise<Array<OperatorPassUnitRow>> {
		const ids = await fetchMany<{pass_id: string}>(FETCH_UNIT_IDS_BY_HOLDER, {holder_id: holderId});
		const units = await Promise.all(ids.map(({pass_id}) => this.findUnit(pass_id)));
		return units
			.filter((unit): unit is OperatorPassUnitRow => unit !== null && unit.holder_id === holderId)
			.sort((left, right) => left.first_delivered_at.getTime() - right.first_delivered_at.getTime());
	}

	async listUnitsByPurchase(purchaseId: string): Promise<Array<OperatorPassUnitRow>> {
		const ids = await fetchMany<{pass_id: string}>(FETCH_UNIT_IDS_BY_PURCHASE, {purchase_id: purchaseId});
		const units = await Promise.all(ids.map(({pass_id}) => this.findUnit(pass_id)));
		return units
			.filter((unit): unit is OperatorPassUnitRow => unit !== null)
			.sort((left, right) => left.pass_id.localeCompare(right.pass_id));
	}

	async appendUnitEvent(row: OperatorPassUnitEventRow): Promise<void> {
		await upsertOne(OperatorPassUnitEvents.upsertAll(row));
	}

	async listUnitEvents(passId: string): Promise<Array<OperatorPassUnitEventRow>> {
		const rows = await fetchMany<OperatorPassUnitEventRow>(FETCH_UNIT_EVENTS, {pass_id: passId});
		return rows.sort(
			(left, right) =>
				left.occurred_at.getTime() - right.occurred_at.getTime() || left.event_id.localeCompare(right.event_id),
		);
	}

	async createOffer(offer: OperatorPassOfferRow): Promise<boolean> {
		const created = await executeConditional(OperatorPassOffers.insertIfNotExists(offer));
		if (created) {
			const batch = new BatchBuilder();
			batch.addPrepared(OperatorPassOffersByUser.upsertAll({user_id: offer.sender_id, offer_id: offer.offer_id}));
			batch.addPrepared(OperatorPassOffersByUser.upsertAll({user_id: offer.recipient_id, offer_id: offer.offer_id}));
			await batch.execute();
		}
		return created;
	}

	async findOffer(offerId: string): Promise<OperatorPassOfferRow | null> {
		return fetchOne<OperatorPassOfferRow>(FETCH_OFFER, {offer_id: offerId});
	}

	async updateOffer(
		current: OperatorPassOfferRow,
		patch: OperatorPassOfferPatch,
	): Promise<OperatorPassOfferRow | null> {
		const version = nextVersion(current.version);
		const applied = await executeConditional(
			OperatorPassOffers.conditionalPatchByPk(
				{offer_id: current.offer_id},
				{...patch, version: Db.set(version)},
				{version: current.version},
			),
		);
		return applied ? withPatch(current, patch, version) : null;
	}

	async listOffersByUser(userId: UserID): Promise<Array<OperatorPassOfferRow>> {
		const ids = await fetchMany<{offer_id: string}>(FETCH_OFFER_IDS_BY_USER, {user_id: userId});
		const offers = await Promise.all(ids.map(({offer_id}) => this.findOffer(offer_id)));
		return offers
			.filter((offer): offer is OperatorPassOfferRow => offer !== null)
			.sort((left, right) => right.created_at.getTime() - left.created_at.getTime());
	}

	async scanOffers(pageSize: number, pageState?: string | null): Promise<OperatorPassScanPage<OperatorPassOfferRow>> {
		const page = await fetchPage<OperatorPassOfferRow>(
			SCAN_OFFERS,
			{},
			{pageSize, pageState, readTimeout: BACKGROUND_READ_TIMEOUT_MS},
		);
		return {rows: page.rows, pageState: page.pageState};
	}

	async saveOperatorPass(pass: OperatorPassRow): Promise<void> {
		await upsertOne(OperatorPasses.upsertAll(pass));
	}
}

function expectedWaitlistVersion(row: OperatorPassWaitlistRow): Partial<OperatorPassWaitlistRow> {
	return row.version == null ? {entry_id: row.entry_id} : {version: row.version};
}

function waitlistRowPatch(entry: OperatorPassWaitlistRow): OperatorPassWaitlistPatch {
	const patch: Record<string, DbOp<unknown>> = {};
	for (const column of OPERATOR_PASS_WAITLIST_COLUMNS) {
		if (column === 'email') continue;
		const value = entry[column];
		patch[column] = value == null ? Db.clear() : Db.set(value);
	}
	return patch as OperatorPassWaitlistPatch;
}
