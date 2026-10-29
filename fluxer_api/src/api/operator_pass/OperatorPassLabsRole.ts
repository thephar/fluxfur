// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createRoleID, type GuildID, type RoleID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {GuildService} from '@app/api/guild/services/GuildService';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import {
	isOperatorPassEntitled,
	loadOperatorPassEntitlementState,
} from '@app/api/operator_pass/OperatorPassEntitlementService';
import {OperatorPassRepository} from '@app/api/operator_pass/OperatorPassRepository';

export const OPERATOR_PASS_LABS_INVITE_URL = 'https://fluxer.gg/fluxer-labs';

interface LabsOperatorRole {
	guildId: GuildID;
	roleId: RoleID;
}

const joinHookRepository = new OperatorPassRepository();

function getLabsOperatorRole(): LabsOperatorRole | null {
	const {labsGuildId, labsOperatorRoleId} = Config.operatorPass;
	if (Config.instance.selfHosted || labsGuildId == null || labsOperatorRoleId == null) {
		return null;
	}
	return {guildId: createGuildID(labsGuildId), roleId: createRoleID(labsOperatorRoleId)};
}

export async function resolveOperatorPassJoinRoleIds(
	guildId: GuildID,
	user: User,
	guildRepository: GuildRepository,
): Promise<Set<RoleID> | null> {
	const labs = getLabsOperatorRole();
	if (!labs || labs.guildId !== guildId) {
		return null;
	}
	if (!isOperatorPassEntitled(await loadOperatorPassEntitlementState(joinHookRepository, user.id))) {
		return null;
	}
	const role = await guildRepository.getRole(labs.roleId, guildId);
	return role ? new Set([labs.roleId]) : null;
}

export class OperatorPassLabsRoleService {
	constructor(
		private readonly guildRepository: GuildRepository,
		private readonly guildService: GuildService,
	) {}

	async ensureOperatorRole(userId: UserID): Promise<void> {
		const labs = getLabsOperatorRole();
		if (!labs) {
			Logger.warn({userId}, 'Fluxer Labs guild or Operator role is not configured; skipping Operator role grant');
			return;
		}
		const requestCache = createRequestCache();
		try {
			const member = await this.guildRepository.getMember(labs.guildId, userId);
			if (!member) {
				await this.guildService.members.addUserToGuild({
					userId,
					guildId: labs.guildId,
					sendJoinMessage: true,
					skipAccountLimitCheck: true,
					requestCache,
				});
			}
			await this.guildService.members.systemAddMemberRole({
				targetId: userId,
				guildId: labs.guildId,
				roleId: labs.roleId,
				initiatorId: SYSTEM_USER_ID,
				requestCache,
			});
		} catch (error) {
			Logger.error(
				{userId, guildId: labs.guildId, roleId: labs.roleId, error},
				'Failed to grant the Operator role in Fluxer Labs',
			);
		}
	}

	private async grantOperatorRoleIfMember(userId: UserID): Promise<boolean> {
		const labs = getLabsOperatorRole();
		if (!labs) {
			return false;
		}
		const member = await this.guildRepository.getMember(labs.guildId, userId);
		if (!member || member.roleIds.has(labs.roleId)) {
			return false;
		}
		await this.guildService.members.systemAddMemberRole({
			targetId: userId,
			guildId: labs.guildId,
			roleId: labs.roleId,
			initiatorId: SYSTEM_USER_ID,
			requestCache: createRequestCache(),
		});
		return true;
	}

	async syncOperatorRole(userId: UserID, entitled: boolean): Promise<void> {
		if (!entitled) {
			await this.removeOperatorRole(userId);
			return;
		}
		try {
			await this.grantOperatorRoleIfMember(userId);
		} catch (error) {
			Logger.error({userId, error}, 'Failed to give the Operator role back in Fluxer Labs');
		}
	}

	private async removeOperatorRole(userId: UserID): Promise<void> {
		const labs = getLabsOperatorRole();
		if (!labs) {
			return;
		}
		try {
			const member = await this.guildRepository.getMember(labs.guildId, userId);
			if (!member?.roleIds.has(labs.roleId)) {
				return;
			}
			await this.guildService.members.systemRemoveMemberRole({
				targetId: userId,
				guildId: labs.guildId,
				roleId: labs.roleId,
				initiatorId: SYSTEM_USER_ID,
				requestCache: createRequestCache(),
			});
		} catch (error) {
			Logger.error(
				{userId, guildId: labs.guildId, roleId: labs.roleId, error},
				'Failed to remove the Operator role in Fluxer Labs',
			);
		}
	}
}
