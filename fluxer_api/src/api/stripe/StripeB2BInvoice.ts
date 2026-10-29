// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import {extractId} from '@app/api/stripe/StripeUtils';
import type Stripe from 'stripe';

const B2B_INVOICE_METADATA_KEY = 'b2b_invoice_id';
const INVOICE_LINE_ITEM_LIMIT = 20;

export async function ensureB2BInvoiceForCheckout(
	stripe: Stripe | null,
	session: Stripe.Checkout.Session,
): Promise<string | null> {
	if (
		!stripe ||
		session.mode !== 'payment' ||
		session.payment_status !== 'paid' ||
		extractId(session.invoice) !== null
	) {
		return null;
	}
	const customerId = extractId(session.customer);
	if (customerId === null) {
		return null;
	}
	const hasTaxIds = (session.customer_details?.tax_ids?.length ?? 0) > 0;
	if (!hasTaxIds) {
		return null;
	}
	const paymentIntentId = extractId(session.payment_intent);
	if (paymentIntentId) {
		const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
		const existing = intent.metadata?.[B2B_INVOICE_METADATA_KEY];
		if (existing) {
			return existing;
		}
	}
	const currency = session.currency;
	if (!currency) {
		return null;
	}
	const draft = await stripe.invoices.create(
		{
			customer: customerId,
			currency,
			collection_method: 'send_invoice',
			days_until_due: 0,
			auto_advance: false,
			pending_invoice_items_behavior: 'exclude',
			automatic_tax: {enabled: session.automatic_tax?.enabled === true},
			metadata: {checkout_session_id: session.id, ...(paymentIntentId ? {payment_intent_id: paymentIntentId} : {})},
		},
		{idempotencyKey: `b2b-invoice:${session.id}`},
	);
	const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
		limit: INVOICE_LINE_ITEM_LIMIT,
		expand: ['data.price'],
	});
	for (const [index, item] of lineItems.data.entries()) {
		const price = item.price;
		const productId = price ? extractId(price.product) : null;
		const unitAmount = price?.unit_amount ?? null;
		const invoiceItems = stripe.invoiceItems;
		const params: Stripe.InvoiceItemCreateParams = {
			customer: customerId,
			invoice: draft.id,
			currency,
			quantity: item.quantity ?? 1,
		};
		if (productId && unitAmount !== null) {
			params.price_data = {
				currency,
				product: productId,
				unit_amount: unitAmount,
				tax_behavior: price?.tax_behavior === 'exclusive' ? 'exclusive' : 'inclusive',
			};
		} else {
			params.amount = item.amount_total;
			params.description = item.description ?? undefined;
		}
		await invoiceItems.create(params, {idempotencyKey: `b2b-invoice-item:${session.id}:${index}`});
	}
	const finalized = await stripe.invoices.finalizeInvoice(draft.id, {auto_advance: false});
	await stripe.invoices.pay(finalized.id, {paid_out_of_band: true}, {idempotencyKey: `b2b-invoice-pay:${session.id}`});
	if (paymentIntentId) {
		await stripe.paymentIntents.update(paymentIntentId, {metadata: {[B2B_INVOICE_METADATA_KEY]: finalized.id}});
	}
	Logger.info({sessionId: session.id, invoiceId: finalized.id}, 'Created a business invoice for a paid checkout');
	return finalized.id;
}
