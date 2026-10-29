// SPDX-License-Identifier: AGPL-3.0-or-later

import {PAYMENT_PROVIDER_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {Trans} from '@lingui/react/macro';

interface SubscriptionBillingChangeDescriptionProps {
	effectiveAt: 'now' | 'period_end';
	isSwitchingToYearly: boolean;
	firstRenewalPriceLabel: string | null;
	creditLabel: string | null;
	renewalPrice: string;
}

export function SubscriptionBillingChangeDescription({
	effectiveAt,
	isSwitchingToYearly,
	firstRenewalPriceLabel,
	creditLabel,
	renewalPrice,
}: SubscriptionBillingChangeDescriptionProps) {
	if (effectiveAt === 'period_end') {
		if (isSwitchingToYearly && firstRenewalPriceLabel && creditLabel) {
			return (
				<Trans>
					Takes effect at your next renewal. We'll apply a {creditLabel} credit from your current monthly payment, so
					your first yearly charge will be{' '}
					<strong data-flx="app.plutonium.subscription-card.handle-confirm-billing-cycle-change.strong">
						{firstRenewalPriceLabel}
					</strong>
					. Future yearly renewals will be {renewalPrice}/year.
				</Trans>
			);
		}
		if (isSwitchingToYearly) {
			return (
				<Trans>
					Takes effect at your next renewal. Your subscription stays monthly until then, and your next renewal will be{' '}
					<strong data-flx="app.plutonium.subscription-card.handle-confirm-billing-cycle-change.strong">
						{renewalPrice}/year
					</strong>
					.
				</Trans>
			);
		}
		return (
			<Trans>
				Takes effect at your next renewal. Your subscription stays yearly until then, and your next renewal will be{' '}
				<strong data-flx="app.plutonium.subscription-card.handle-confirm-billing-cycle-change.strong--2">
					{renewalPrice}/month
				</strong>
				.
			</Trans>
		);
	}
	if (isSwitchingToYearly) {
		return (
			<Trans>
				Takes effect immediately. A prorated charge may apply via {PAYMENT_PROVIDER_NAME}. Your next renewal will be{' '}
				<strong data-flx="app.plutonium.subscription-card.handle-confirm-billing-cycle-change.strong">
					{renewalPrice}/year
				</strong>
				.
			</Trans>
		);
	}
	return (
		<Trans>
			Takes effect immediately. A prorated adjustment may apply via {PAYMENT_PROVIDER_NAME}. Your next renewal will be{' '}
			<strong data-flx="app.plutonium.subscription-card.handle-confirm-billing-cycle-change.strong--2">
				{renewalPrice}/month
			</strong>
			.
		</Trans>
	);
}
