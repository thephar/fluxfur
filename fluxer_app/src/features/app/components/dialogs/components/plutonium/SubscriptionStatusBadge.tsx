// SPDX-License-Identifier: AGPL-3.0-or-later

import statusStyles from '@app/features/app/components/dialogs/components/plutonium/PurchaseHistoryStatus.module.css';
import {Trans} from '@lingui/react/macro';
import type {ReactNode} from 'react';

interface SubscriptionStatusBadgeProps {
	isFullyExpired: boolean;
	isInGracePeriod: boolean;
	perksDisabled: boolean;
	premiumWillCancel: boolean;
	hasPendingSubscriptionChange: boolean;
	isVisionary: boolean;
	isGiftSubscription: boolean;
}

export function SubscriptionStatusBadge({
	isFullyExpired,
	isInGracePeriod,
	perksDisabled,
	premiumWillCancel,
	hasPendingSubscriptionChange,
	isVisionary,
	isGiftSubscription,
}: SubscriptionStatusBadgeProps) {
	let className: string;
	let label: ReactNode;
	if (isFullyExpired) {
		className = statusStyles.danger;
		label = <Trans comment="Subscription status badge meaning premium access has fully expired.">Expired</Trans>;
	} else if (isInGracePeriod) {
		className = statusStyles.pending;
		label = (
			<Trans comment="Subscription status badge meaning access remains briefly after subscription end.">
				Grace period
			</Trans>
		);
	} else if (perksDisabled) {
		className = statusStyles.muted;
		label = (
			<Trans comment="Subscription status badge meaning premium is paid but perks are temporarily disabled.">
				Perks paused
			</Trans>
		);
	} else if (premiumWillCancel) {
		className = statusStyles.pending;
		label = (
			<Trans comment="Subscription status badge meaning cancellation is scheduled for the renewal date.">
				Canceling
			</Trans>
		);
	} else if (hasPendingSubscriptionChange) {
		className = statusStyles.pending;
		label = (
			<Trans comment="Subscription status badge meaning a future billing plan change is scheduled.">
				Change scheduled
			</Trans>
		);
	} else if (isVisionary) {
		return null;
	} else if (isGiftSubscription) {
		className = statusStyles.neutral;
		label = <Trans comment="Subscription status badge meaning premium access came from a gift.">Gift</Trans>;
	} else {
		className = statusStyles.success;
		label = <Trans comment="Subscription status badge meaning the paid subscription is active.">Active</Trans>;
	}

	return (
		<span className={className} data-flx="app.plutonium.subscription-card.badge">
			{label}
		</span>
	);
}
