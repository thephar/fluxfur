// SPDX-License-Identifier: AGPL-3.0-or-later

import i18n from '@app/app/I18n';
import {GenericErrorModal} from '@app/features/app/components/alerts/GenericErrorModal';
import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import styles from '@app/features/app/components/dialogs/components/plutonium/PurchaseHistorySection.module.css';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {failureCode} from '@app/features/platform/utils/ResponseInspection';
import * as PremiumCommands from '@app/features/premium/commands/PremiumCommands';
import {PlutoniumPageButton} from '@app/features/premium/components/plutonium_page/PlutoniumPageButton';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {getFormattedShortDate} from '@fluxer/date_utils/src/DateFormatting';
import type {SelfServeRefundEligibilityResponse} from '@fluxer/schema/src/domains/premium/PremiumSchemas';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useCallback, useState} from 'react';

const REFUND_YOUR_MOST_RECENT_PURCHASE_DESCRIPTOR = msg({
	message: 'Refund your most recent purchase?',
	comment: 'Question prompt in the Plutonium self serve refund section. Keep the tone plain and specific.',
});
const REFUND_PURCHASE_DESCRIPTOR = msg({
	message: 'Refund purchase',
	comment: 'Short label in the Plutonium self serve refund section. Keep the tone plain and specific.',
});
const NOT_NOW_DESCRIPTOR = msg({
	message: 'Not now',
	comment: 'Short label in the Plutonium self serve refund section. Keep the tone plain and specific.',
});
const REFUND_ISSUED_IT_MAY_TAKE_A_FEW_BUSINESS_DESCRIPTOR = msg({
	message: 'Refund issued. May take a few business days to appear.',
	comment: 'Toast success shown after a self-serve refund is issued. Keep plain.',
});
const REFUND_OUTSIDE_WINDOW_TITLE_DESCRIPTOR = msg({
	message: 'Outside the refund window',
	comment: 'Title of the error modal shown when a self-serve refund is no longer within the eligible window.',
});
const REFUND_OUTSIDE_WINDOW_MESSAGE_DESCRIPTOR = msg({
	message: 'Your most recent purchase is no longer within the refund window. Contact support for billing issues.',
	comment: 'Body of the error modal shown when a self-serve refund is no longer within the eligible window.',
});
const REFUND_COOLDOWN_TITLE_DESCRIPTOR = msg({
	message: 'You have refunded recently',
	comment: 'Title of the error modal shown when a self-serve refund is blocked by the cooldown period.',
});
const REFUND_COOLDOWN_MESSAGE_DESCRIPTOR = msg({
	message: "You've already used a self-serve refund recently. You can refund again once the cooldown ends.",
	comment: 'Body of the error modal shown when a self-serve refund is blocked by the cooldown period.',
});
const REFUND_NO_PURCHASE_TITLE_DESCRIPTOR = msg({
	message: 'Nothing to refund',
	comment: 'Title of the error modal shown when there is no refundable purchase on the account.',
});
const REFUND_NO_PURCHASE_MESSAGE_DESCRIPTOR = msg({
	message: "We couldn't find a recent purchase to refund on this account.",
	comment: 'Body of the error modal shown when there is no refundable purchase on the account.',
});
const REFUND_FAILED_TITLE_DESCRIPTOR = msg({
	message: "Couldn't refund this purchase",
	comment: 'Title of the generic fallback error modal shown when a self-serve refund fails.',
});
const REFUND_FAILED_MESSAGE_DESCRIPTOR = msg({
	message: 'Something went wrong while issuing your refund. Contact support if this keeps happening.',
	comment: 'Body of the generic fallback error modal shown when a self-serve refund fails.',
});
const logger = new Logger('SelfServeRefundSection');

function resolveRefundErrorContent(code: string | undefined): {title: string; message: string} {
	switch (code) {
		case APIErrorCodes.STRIPE_REFUND_OUTSIDE_WINDOW:
			return {
				title: i18n._(REFUND_OUTSIDE_WINDOW_TITLE_DESCRIPTOR),
				message: i18n._(REFUND_OUTSIDE_WINDOW_MESSAGE_DESCRIPTOR),
			};
		case APIErrorCodes.STRIPE_REFUND_COOLDOWN_ACTIVE:
			return {
				title: i18n._(REFUND_COOLDOWN_TITLE_DESCRIPTOR),
				message: i18n._(REFUND_COOLDOWN_MESSAGE_DESCRIPTOR),
			};
		case APIErrorCodes.STRIPE_NO_PURCHASE_HISTORY:
			return {
				title: i18n._(REFUND_NO_PURCHASE_TITLE_DESCRIPTOR),
				message: i18n._(REFUND_NO_PURCHASE_MESSAGE_DESCRIPTOR),
			};
		default:
			return {
				title: i18n._(REFUND_FAILED_TITLE_DESCRIPTOR),
				message: i18n._(REFUND_FAILED_MESSAGE_DESCRIPTOR),
			};
	}
}

function showRefundErrorModal(error: unknown): void {
	const {title, message} = resolveRefundErrorContent(failureCode(error));
	ModalCommands.push(
		modal(() => (
			<GenericErrorModal
				title={title}
				message={message}
				data-flx="app.plutonium.self-serve-refund-section.refund.generic-error-modal"
			/>
		)),
	);
}

interface SelfServeRefundSectionProps {
	eligibility: SelfServeRefundEligibilityResponse | null;
	refreshPremiumState: () => Promise<unknown>;
}

function formatRelativeTime(isoTimestamp: string | null): string | null {
	if (!isoTimestamp) return null;
	const date = new Date(isoTimestamp);
	if (Number.isNaN(date.getTime())) return null;
	return getFormattedShortDate(date, getCurrentLocale());
}

export const SelfServeRefundSection: React.FC<SelfServeRefundSectionProps> = observer(
	({eligibility, refreshPremiumState}) => {
		const {i18n} = useLingui();
		const [submitting, setSubmitting] = useState(false);
		const isGooglePlay = eligibility?.provider === 'google_play';
		const handleRefund = useCallback(() => {
			ModalCommands.push(
				modal(() => (
					<ConfirmModal
						title={i18n._(REFUND_YOUR_MOST_RECENT_PURCHASE_DESCRIPTOR)}
						description={
							isGooglePlay ? (
								<Trans>
									This refunds your most recent Google Play purchase and cancels any subscription it paid for. You won't
									be able to self-refund again for 30 days.
								</Trans>
							) : (
								<Trans>
									This refunds your most recent purchase and cancels any subscription it paid for. You won't be able to
									self-refund again for 30 days.
								</Trans>
							)
						}
						primaryText={i18n._(REFUND_PURCHASE_DESCRIPTOR)}
						primaryVariant="danger"
						secondaryText={i18n._(NOT_NOW_DESCRIPTOR)}
						onPrimary={async () => {
							setSubmitting(true);
							try {
								await PremiumCommands.refundLatestPurchase();
								ToastCommands.success(i18n._(REFUND_ISSUED_IT_MAY_TAKE_A_FEW_BUSINESS_DESCRIPTOR));
								await refreshPremiumState();
							} catch (error) {
								logger.error('Refund failed', error);
								showRefundErrorModal(error);
							} finally {
								setSubmitting(false);
							}
						}}
						data-flx="app.plutonium.self-serve-refund-section.handle-refund.confirm-modal"
					/>
				)),
			);
		}, [refreshPremiumState, i18n, isGooglePlay]);
		if (
			!eligibility ||
			eligibility.reason === 'no_refundable_purchase' ||
			eligibility.reason === 'feature_unavailable'
		) {
			return null;
		}
		const isEligible = eligibility.eligible;
		const windowEndsOn = formatRelativeTime(eligibility.refund_window_expires_at);
		const cooldownEndsOn = formatRelativeTime(eligibility.cooldown_expires_at);
		let description: ReactNode;
		if (isEligible && eligibility.cancels_subscription) {
			description = (
				<Trans>Eligible for a refund until {windowEndsOn}. This will also cancel your subscription immediately.</Trans>
			);
		} else if (isEligible) {
			description = <Trans>Eligible for a refund until {windowEndsOn}.</Trans>;
		} else if (eligibility.reason === 'outside_refund_window') {
			description = <Trans>Your last purchase is outside the refund window. Contact support for billing issues.</Trans>;
		} else if (eligibility.reason === 'cooldown_active') {
			description = <Trans>You can refund again after {cooldownEndsOn}. Contact support for billing issues.</Trans>;
		} else {
			description = <Trans>This purchase is not eligible for a refund.</Trans>;
		}

		return (
			<section className={styles.section} data-flx="app.plutonium.self-serve-refund-section.section">
				<div className={styles.card} data-flx="app.plutonium.self-serve-refund-section.card">
					<div className={styles.grid} data-flx="app.plutonium.self-serve-refund-section.grid">
						<div className={styles.content} data-flx="app.plutonium.self-serve-refund-section.content">
							<h3 className={styles.title} data-flx="app.plutonium.self-serve-refund-section.title">
								<Trans>Refund</Trans>
							</h3>
							<p className={styles.description} data-flx="app.plutonium.self-serve-refund-section.description">
								{description}
							</p>
						</div>
						<PlutoniumPageButton
							variant="danger"
							onClick={handleRefund}
							loading={submitting}
							disabled={!isEligible}
							small
							className={styles.button}
							data-flx="app.plutonium.self-serve-refund-section.button.refund"
						>
							<Trans>Refund purchase</Trans>
						</PlutoniumPageButton>
					</div>
				</div>
			</section>
		);
	},
);
