// SPDX-License-Identifier: AGPL-3.0-or-later

import type {PriceIds} from '@app/features/premium/commands/PremiumCommands';
import {
	areGiftPurchasesAvailable,
	arePremiumPurchasesAvailable,
	canServiceStripeSubscriptions,
	shouldShowPremiumFeatures,
} from '@app/features/premium/utils/PremiumUtils';

type HeroMode = 'member-purchase' | 'member' | 'redeem-only' | 'purchase';

export interface PurchaseSurfaceInput {
	priceIds: PriceIds | null;
	userPurchaseDisabled: boolean;
	isMember: boolean;
	canStartSubscription: boolean;
	hasBillingRelationship: boolean;
}

export interface PurchaseSurface {
	purchasesAvailable: boolean;
	giftPurchasesAvailable: boolean;
	canSubscribe: boolean;
	billingUnavailable: boolean;
	heroMode: HeroMode;
	showClosing: boolean;
}

export function resolvePurchaseSurface(input: PurchaseSurfaceInput): PurchaseSurface {
	const purchasesAvailable = arePremiumPurchasesAvailable(input.userPurchaseDisabled);
	const giftPurchasesAvailable = areGiftPurchasesAvailable(input.priceIds, input.userPurchaseDisabled);
	const billingUnavailable =
		!shouldShowPremiumFeatures() ||
		(!arePremiumPurchasesAvailable() && !(input.hasBillingRelationship && canServiceStripeSubscriptions()));
	const canSubscribe = purchasesAvailable && input.canStartSubscription;
	let heroMode: HeroMode = 'purchase';
	if (input.isMember) {
		heroMode = canSubscribe ? 'member-purchase' : 'member';
	} else if (!purchasesAvailable) {
		heroMode = 'redeem-only';
	}
	return {
		purchasesAvailable,
		giftPurchasesAvailable,
		canSubscribe,
		billingUnavailable,
		heroMode,
		showClosing: canSubscribe || (input.isMember && giftPurchasesAvailable),
	};
}
