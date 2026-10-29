// SPDX-License-Identifier: AGPL-3.0-or-later

import {PRODUCT_LABS_COMMUNITY_NAME, PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import * as InviteCommands from '@app/features/invite/commands/InviteCommands';
import {currentInstanceTarget} from '@app/features/platform/transport/InstanceHTTP';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as OperatorPassCommands from '@app/features/premium/commands/OperatorPassCommands';
import {DONT_LIST_ME_DESCRIPTOR} from '@app/features/premium/components/operator_pass/OperatorPassWallNameField';
import styles from '@app/features/premium/components/pages/PremiumCallbackPage.module.css';
import {
	normalizeOperatorPassWallName,
	OPERATOR_PASS_LABS_INVITE_CODE,
} from '@app/features/premium/utils/OperatorPassUtils';
import {OPERATOR_PASS_OPEN_LABS_DESCRIPTOR} from '@app/features/premium/utils/PremiumMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {WALL_SAVE_FAILED_DESCRIPTOR} from '@app/features/user/components/modals/tabs/my_profile_tab/OperatorPassWallSettings';
import Users from '@app/features/user/state/Users';
import type {OperatorPassListingResponse} from '@fluxer/schema/src/domains/operator_pass/OperatorPassSchemas';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const POLL_INTERVAL_MS = 2000;
const MAX_ATTEMPTS = 15;

type Outcome = {kind: 'loading'} | {kind: 'started'; listing: OperatorPassListingResponse | null} | {kind: 'unknown'};

const logger = new Logger('OperatorPassCheckoutSuccess');

function useCheckoutOutcome(sessionId: string | null): Outcome {
	const [outcome, setOutcome] = useState<Outcome>(sessionId ? {kind: 'loading'} : {kind: 'unknown'});
	useEffect(() => {
		if (!sessionId) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const listingNow = async (): Promise<OperatorPassListingResponse | null> => {
			try {
				return await OperatorPassCommands.fetchListing();
			} catch (error) {
				logger.warn("Failed to load the Operators' wall listing", error);
				return null;
			}
		};
		const check = async (attempt: number) => {
			try {
				const purchase = (await OperatorPassCommands.fetchPurchases()).find((entry) => entry.id === sessionId);
				if (!active) return;
				if (purchase?.status === 'completed') {
					const listing = await listingNow();
					if (active) setOutcome({kind: 'started', listing});
					return;
				}
				if (purchase && purchase.status !== 'pending') {
					setOutcome({kind: 'unknown'});
					return;
				}
			} catch (error) {
				logger.warn('Failed to load the Operator Pass purchase', error);
				if (!active) return;
			}
			if (attempt + 1 >= MAX_ATTEMPTS) {
				setOutcome({kind: 'unknown'});
				return;
			}
			timer = setTimeout(() => void check(attempt + 1), POLL_INTERVAL_MS);
		};
		void check(0);
		return () => {
			active = false;
			if (timer) clearTimeout(timer);
		};
	}, [sessionId]);
	return outcome;
}

export const OperatorPassCheckoutSuccess = observer(function OperatorPassCheckoutSuccess({
	sessionId,
}: {
	sessionId: string | null;
}) {
	const {i18n} = useLingui();
	const outcome = useCheckoutOutcome(sessionId);
	const [changed, setChanged] = useState<OperatorPassListingResponse | null>(null);
	const [saving, setSaving] = useState(false);
	const initial = outcome.kind === 'started' ? outcome.listing : null;
	const listing = changed ?? initial;
	const listed = listing ? listing.status === 'listed' : null;
	const offersOptOut = initial != null && (initial.status === 'listed' || initial.wall_opt_out);
	const wallName =
		(initial?.status === 'listed' ? initial.wall_name : null) ??
		normalizeOperatorPassWallName(Users.currentUser?.displayName ?? '');
	const handleOptOutChange = async (optOut: boolean) => {
		setSaving(true);
		try {
			setChanged(
				await OperatorPassCommands.updateListing(
					optOut ? {wall_name: null, wall_opt_out: true} : {wall_name: wallName, wall_opt_out: false},
				),
			);
		} catch (error) {
			logger.warn("Failed to update the Operators' wall listing after checkout", error);
			ToastCommands.error(i18n._(WALL_SAVE_FAILED_DESCRIPTOR));
		} finally {
			setSaving(false);
		}
	};
	const renderDescription = () => {
		switch (outcome.kind) {
			case 'loading':
				return <Spinner data-flx="premium.operator-pass-checkout-success.spinner" />;
			case 'started':
				if (listed === true) {
					return (
						<p className={styles.description} data-flx="premium.operator-pass-checkout-success.started-listed">
							<Trans comment="Line after an Operator Pass purchase by someone listed on the Operators' wall, the list of Operators on the homepage. The badge is the Operator badge on their profile. Once we check it means after the team reviews the name.">
								Your badge is live. Your name shows on the Operators' wall once we check it.
							</Trans>
						</p>
					);
				}
				if (listed === false) {
					return (
						<p className={styles.description} data-flx="premium.operator-pass-checkout-success.started-unlisted">
							<Trans comment="Line after an Operator Pass purchase by someone who chose not to be listed on the Operators' wall. The badge is the Operator badge on their profile.">
								Your badge is live.
							</Trans>
						</p>
					);
				}
				return (
					<p className={styles.description} data-flx="premium.operator-pass-checkout-success.started">
						<Trans comment="Line after an Operator Pass purchase when the app could not tell whether the buyer is listed on the Operators' wall. The badge is the Operator badge on their profile. The wall listing is their entry on the Operators' wall, which they can check in their settings.">
							Your badge is live. Check your wall listing in settings.
						</Trans>
					</p>
				);
			case 'unknown':
				return (
					<p className={styles.description} data-flx="premium.operator-pass-checkout-success.unknown">
						<Trans comment="Line after an Operator Pass purchase when the app could not load the purchase yet. The confirmation email says when the pass is delivered.">
							Payment received. Your pass arrives in a moment. Details are in your email.
						</Trans>
					</p>
				);
		}
	};
	return (
		<div className={styles.content} data-flx="premium.operator-pass-checkout-success.content">
			<h1 className={styles.title} data-flx="premium.operator-pass-checkout-success.title">
				<Trans comment="Heading after a successful Operator Pass purchase. Backing means supporting the project.">
					Thanks for backing {PRODUCT_NAME}
				</Trans>
			</h1>
			{renderDescription()}
			{offersOptOut && wallName && (
				<Checkbox
					checked={listed === false}
					onChange={(optOut) => void handleOptOutChange(optOut)}
					disabled={saving}
					data-flx="premium.operator-pass-checkout-success.checkbox.opt-out"
				>
					{i18n._(DONT_LIST_ME_DESCRIPTOR)}
				</Checkbox>
			)}
			{outcome.kind !== 'loading' && (
				<Button
					variant="secondary"
					onClick={() => void InviteCommands.openAcceptModal(OPERATOR_PASS_LABS_INVITE_CODE, currentInstanceTarget())}
					data-flx="premium.operator-pass-checkout-success.button.labs"
				>
					{i18n._(OPERATOR_PASS_OPEN_LABS_DESCRIPTOR, {labsName: PRODUCT_LABS_COMMUNITY_NAME})}
				</Button>
			)}
			{outcome.kind !== 'loading' && (
				<p className={styles.description} data-flx="premium.operator-pass-checkout-success.close-tab">
					<Trans comment="Muted line at the bottom of the page after an Operator Pass purchase, which opens in its own browser tab.">
						You can close this tab.
					</Trans>
				</p>
			)}
		</div>
	);
});
