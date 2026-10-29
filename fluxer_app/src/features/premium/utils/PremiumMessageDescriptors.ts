// SPDX-License-Identifier: AGPL-3.0-or-later

import {msg} from '@lingui/core/macro';

export const BUY_GIFT_DESCRIPTOR = msg({
	message: 'Buy gift',
	comment: 'Checkout button for buying a gift subscription.',
});
export const MANAGE_SUBSCRIPTION_DESCRIPTOR = msg({
	message: 'Manage subscription',
	comment: 'Billing action that opens subscription management or the customer billing portal.',
});
export const CLAIM_ACCOUNT_TO_PURCHASE_OR_REDEEM_PREMIUM_DESCRIPTOR = msg({
	message: 'Claim your account to purchase or redeem {premiumProductFullName}.',
	comment:
		'Billing tooltip shown when an unclaimed account cannot buy or redeem premium. premiumProductFullName is the full paid product name.',
});
export const GIFT_PREMIUM_DESCRIPTOR = msg({
	message: 'Gift {premiumProductName}',
	comment: 'Premium gift purchase section title. premiumProductName is the short paid product name.',
});
export const PREMIUM_SUBSCRIPTION_DESCRIPTOR = msg({
	message: '{premiumProductName} subscription',
	comment: 'Premium subscription card title. premiumProductName is the short paid product name.',
});
export const VIEW_PLANS_DESCRIPTOR = msg({
	message: 'View plans',
	comment: 'Button in a premium upsell banner that opens available paid plans.',
});

export const CUSTOMER_PORTAL_FAILED_TITLE_DESCRIPTOR = msg({
	message: "Couldn't open the billing portal",
	comment:
		'Title of the error modal shown when opening the billing customer portal from the premium-expired nagbar fails.',
});
export const CUSTOMER_PORTAL_FAILED_MESSAGE_DESCRIPTOR = msg({
	message: 'Something went wrong while opening the billing portal. Please try again in a moment.',
	comment:
		'Body of the error modal shown when opening the billing customer portal from the premium-expired nagbar fails.',
});
export const PAYMENT_DISPUTE_OPEN_DESCRIPTOR = msg({
	message:
		'Purchases are paused while a payment dispute on your account is open. They come back on their own when the dispute closes.',
	comment:
		'Shown wherever something can be bought while a payment dispute this account made is open. A payment dispute is a chargeback filed with a bank or card company. Every purchase is paused until the bank closes the dispute, then purchases come back without the person doing anything. Neutral tone, never suggest the person did something wrong.',
});
export const PURCHASES_PAUSED_TITLE_DESCRIPTOR = msg({
	message: 'Purchases paused',
	comment: 'Dialog title when checkout is refused because a payment dispute this account made is still open.',
});
export const OPERATOR_PASS_CHARACTERISTICS_DESCRIPTOR = msg({
	message:
		"A spot on the Operators' wall, whenever you want it, and the Operator badge, for life, as long as we run {productName}.",
	comment:
		"What an Operator Pass gives, shown at checkout and when someone offers you a pass. The Operators' wall is the list of Operators on the homepage. Whenever you want it means the buyer can choose not to be listed and join the wall later. Operator is the badge name. For life means for as long as the official service and website run, and the part after it says so. {productName} is the product name.",
});
export const OPERATOR_PASS_LISTING_UNCHANGED_DESCRIPTOR = msg({
	message: "Your Operators' wall listing stays the same.",
	comment:
		"Line for someone who already has an Operator Pass and gets another one, at checkout or when accepting an offer. The Operators' wall is the list of Operators on the homepage.",
});
export const OPERATOR_PASS_REQUIRED_BOX_DESCRIPTOR = msg({
	message: 'Check this box to continue.',
	comment:
		'Error under a required checkbox in the Operator Pass checkout dialog or the dialog for an Operator Pass someone offered you, shown when they try to continue without checking it.',
});
export const OPERATOR_PASS_OPEN_LABS_DESCRIPTOR = msg({
	message: 'Open {labsName}',
	comment:
		'Button in the Operator Pass dialog and on the page after an Operator Pass purchase. It opens the invite to {labsName}, the community that has #operators and the Operator role.',
});
