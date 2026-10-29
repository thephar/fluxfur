// SPDX-License-Identifier: AGPL-3.0-or-later

import {STRIPE_API_VERSION} from '@app/api/stripe/StripeApiVersion';
import {ensureB2BInvoiceForCheckout} from '@app/api/stripe/StripeB2BInvoice';
import {server} from '@app/api/test/msw/server';
import {HttpStatus} from '@fluxer/constants/src/HttpConstants';
import {HttpResponse, http} from 'msw';
import Stripe from 'stripe';
import {describe, expect, test} from 'vitest';

function customerDetails(
	overrides: Partial<Stripe.Checkout.Session.CustomerDetails> = {},
): Stripe.Checkout.Session.CustomerDetails {
	return {
		address: null,
		business_name: null,
		email: 'buyer@example.com',
		individual_name: null,
		name: 'Buyer',
		phone: null,
		tax_exempt: 'none',
		tax_ids: [{type: 'eu_vat', value: 'SE556677889901'}],
		...overrides,
	};
}

function session(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
	return {
		id: 'cs_b2b_1',
		object: 'checkout.session',
		adaptive_pricing: null,
		after_expiration: null,
		allow_promotion_codes: null,
		amount_subtotal: 39800,
		amount_total: 39800,
		automatic_tax: {enabled: true, liability: null, provider: null, status: 'complete'},
		billing_address_collection: null,
		cancel_url: null,
		client_reference_id: null,
		client_secret: null,
		collected_information: null,
		consent: null,
		consent_collection: null,
		created: 1700000000,
		currency: 'eur',
		currency_conversion: null,
		custom_fields: [],
		custom_text: {after_submit: null, shipping_address: null, submit: null, terms_of_service_acceptance: null},
		customer: 'cus_b2b',
		customer_account: null,
		customer_creation: null,
		customer_details: customerDetails(),
		customer_email: null,
		discounts: null,
		expires_at: 1700086400,
		integration_identifier: null,
		invoice: null,
		invoice_creation: null,
		livemode: false,
		locale: null,
		managed_payments: null,
		metadata: {},
		mode: 'payment',
		origin_context: null,
		payment_intent: 'pi_b2b',
		payment_link: null,
		payment_method_collection: null,
		payment_method_configuration_details: null,
		payment_method_options: null,
		payment_method_types: ['card'],
		payment_status: 'paid',
		permissions: null,
		recovered_from: null,
		saved_payment_method_options: null,
		setup_intent: null,
		shipping_address_collection: null,
		shipping_cost: null,
		shipping_options: [],
		status: 'complete',
		submit_type: null,
		subscription: null,
		success_url: null,
		total_details: null,
		ui_mode: null,
		url: null,
		wallet_options: null,
		...overrides,
	};
}

function price(overrides: Partial<Stripe.Price> = {}): Stripe.Price {
	return {
		id: 'price_pass',
		object: 'price',
		active: true,
		billing_scheme: 'per_unit',
		created: 1700000000,
		currency: 'eur',
		custom_unit_amount: null,
		livemode: false,
		lookup_key: null,
		metadata: {},
		nickname: null,
		product: 'prod_pass',
		recurring: null,
		tax_behavior: 'inclusive',
		tiers_mode: null,
		transform_quantity: null,
		type: 'one_time',
		unit_amount: 19900,
		unit_amount_decimal: null,
		...overrides,
	};
}

function lineItem(overrides: Partial<Stripe.LineItem> = {}): Stripe.LineItem {
	return {
		id: 'li_pass',
		object: 'item',
		adjustable_quantity: null,
		amount_discount: 0,
		amount_subtotal: 39800,
		amount_tax: 0,
		amount_total: 39800,
		currency: 'eur',
		description: 'Fluxer Operator Pass',
		metadata: null,
		price: price(),
		quantity: 2,
		...overrides,
	};
}

interface RecordedRequest {
	method: string;
	path: string;
	params: Record<string, string>;
	idempotencyKey: string | null;
}

function recordStripeInvoices({
	existingInvoiceId,
	lines = [lineItem()],
}: {
	existingInvoiceId?: string;
	lines?: Array<Stripe.LineItem>;
} = {}) {
	const requests: Array<RecordedRequest> = [];
	server.use(
		http.all('https://api.stripe.com/v1/*', async ({request}) => {
			const url = new URL(request.url);
			const params = request.method === 'GET' ? url.searchParams : new URLSearchParams(await request.text());
			requests.push({
				method: request.method,
				path: url.pathname,
				params: Object.fromEntries(params),
				idempotencyKey: request.headers.get('idempotency-key'),
			});
			switch (`${request.method} ${url.pathname}`) {
				case 'GET /v1/payment_intents/pi_b2b':
					return HttpResponse.json({id: 'pi_b2b', metadata: {b2b_invoice_id: existingInvoiceId}});
				case 'POST /v1/invoices':
					return HttpResponse.json({id: 'in_draft'});
				case 'GET /v1/checkout/sessions/cs_b2b_1/line_items':
					return HttpResponse.json({object: 'list', data: lines, has_more: false, url: url.pathname});
				case 'POST /v1/invoiceitems':
					return HttpResponse.json({id: 'ii_b2b'});
				case 'POST /v1/invoices/in_draft/finalize':
					return HttpResponse.json({id: 'in_final'});
				case 'POST /v1/invoices/in_final/pay':
					return HttpResponse.json({id: 'in_final', status: 'paid'});
				case 'POST /v1/payment_intents/pi_b2b':
					return HttpResponse.json({id: 'pi_b2b', metadata: {b2b_invoice_id: 'in_final'}});
				default:
					return HttpResponse.json({error: {message: 'Unexpected Stripe request'}}, {status: HttpStatus.BAD_REQUEST});
			}
		}),
	);
	const stripe = new Stripe('sk_test_b2b', {
		apiVersion: STRIPE_API_VERSION,
		httpClient: Stripe.createFetchHttpClient(),
		maxNetworkRetries: 0,
	});
	return {stripe, requests};
}

describe('business invoices after checkout', () => {
	test.each([
		{label: 'without customer details', overrides: {customer_details: null}},
		{label: 'without tax IDs', overrides: {customer_details: customerDetails({tax_ids: []})}},
		{label: 'with null tax IDs', overrides: {customer_details: customerDetails({tax_ids: null})}},
		{label: 'with an existing invoice', overrides: {invoice: 'in_existing'}},
		{label: 'for a subscription', overrides: {mode: 'subscription'}},
		{label: 'while unpaid', overrides: {payment_status: 'unpaid'}},
		{label: 'without a customer', overrides: {customer: null}},
		{label: 'with an empty customer ID', overrides: {customer: ''}},
	] satisfies Array<{label: string; overrides: Partial<Stripe.Checkout.Session>}>)(
		'skips checkout $label',
		async ({overrides}) => {
			const {stripe, requests} = recordStripeInvoices();
			expect(await ensureB2BInvoiceForCheckout(stripe, session(overrides))).toBeNull();
			expect(requests).toEqual([]);
		},
	);

	test('creates and pays an invoice with checkout currency and stable request keys', async () => {
		const {stripe, requests} = recordStripeInvoices();
		expect(await ensureB2BInvoiceForCheckout(stripe, session())).toBe('in_final');
		expect(requests.map(({method, path}) => `${method} ${path}`)).toEqual([
			'GET /v1/payment_intents/pi_b2b',
			'POST /v1/invoices',
			'GET /v1/checkout/sessions/cs_b2b_1/line_items',
			'POST /v1/invoiceitems',
			'POST /v1/invoices/in_draft/finalize',
			'POST /v1/invoices/in_final/pay',
			'POST /v1/payment_intents/pi_b2b',
		]);
		expect(requests[1]).toMatchObject({
			params: {
				customer: 'cus_b2b',
				currency: 'eur',
				collection_method: 'send_invoice',
				days_until_due: '0',
				auto_advance: 'false',
				pending_invoice_items_behavior: 'exclude',
				'automatic_tax[enabled]': 'true',
				'metadata[checkout_session_id]': 'cs_b2b_1',
				'metadata[payment_intent_id]': 'pi_b2b',
			},
			idempotencyKey: 'b2b-invoice:cs_b2b_1',
		});
		expect(requests[2]?.params).toEqual({limit: '20', 'expand[0]': 'data.price'});
		expect(requests[3]).toMatchObject({
			params: {
				customer: 'cus_b2b',
				invoice: 'in_draft',
				currency: 'eur',
				quantity: '2',
				'price_data[currency]': 'eur',
				'price_data[product]': 'prod_pass',
				'price_data[unit_amount]': '19900',
				'price_data[tax_behavior]': 'inclusive',
			},
			idempotencyKey: 'b2b-invoice-item:cs_b2b_1:0',
		});
		expect(requests[4]?.params).toEqual({auto_advance: 'false'});
		expect(requests[5]).toMatchObject({params: {paid_out_of_band: 'true'}, idempotencyKey: 'b2b-invoice-pay:cs_b2b_1'});
		expect(requests[6]?.params).toEqual({'metadata[b2b_invoice_id]': 'in_final'});
	});

	test('returns an already recorded invoice without writes', async () => {
		const {stripe, requests} = recordStripeInvoices({existingInvoiceId: 'in_earlier'});
		expect(await ensureB2BInvoiceForCheckout(stripe, session())).toBe('in_earlier');
		expect(requests).toEqual([{method: 'GET', path: '/v1/payment_intents/pi_b2b', params: {}, idempotencyKey: null}]);
	});

	test('does nothing without Stripe', async () => {
		const {requests} = recordStripeInvoices();
		expect(await ensureB2BInvoiceForCheckout(null, session())).toBeNull();
		expect(requests).toEqual([]);
	});
});
