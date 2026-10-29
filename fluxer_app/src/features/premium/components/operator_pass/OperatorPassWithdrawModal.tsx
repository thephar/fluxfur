// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as OperatorPassCommands from '@app/features/premium/commands/OperatorPassCommands';
import styles from '@app/features/premium/components/operator_pass/OperatorPassWithdraw.module.css';
import {
	formatOperatorPassCalendarDay,
	formatOperatorPassDate,
	formatOperatorPassDateTime,
} from '@app/features/premium/utils/OperatorPassUtils';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Input} from '@app/features/ui/components/form/FormInput';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import {HttpStatus} from '@fluxer/constants/src/HttpConstants';
import {formatMinorUnitPrice} from '@fluxer/number_utils/src/PriceFormatting';
import type {
	OperatorPassPurchaseResponse,
	OperatorPassUnitResponse,
} from '@fluxer/schema/src/domains/operator_pass/OperatorPassSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useRef, useState} from 'react';

export const WITHDRAW_FROM_CONTRACT_HERE_DESCRIPTOR = msg({
	message: 'Withdraw from contract here',
	comment:
		'Button on a paid Operator Pass purchase that was not delivered yet. Statutory wording from EU consumer law (Directive 2023/2673, article 11a, the withdrawal function). Use the exact words of your language version of the directive if it has one (sv-SE: Ångra avtalet här), otherwise translate the English faithfully. "Withdraw" means using the EU consumer right of withdrawal on a paid Operator Pass purchase that was not delivered yet, for a full refund. Never a word for taking money out.',
});
const WITHDRAW_TITLE_DESCRIPTOR = msg({
	message: 'Withdraw from contract',
	comment:
		'Title of the dialog that withdraws from a paid Operator Pass purchase that was not delivered yet. "Withdraw" means using the EU consumer right of withdrawal on a paid Operator Pass purchase that was not delivered yet, for a full refund. Never a word for taking money out.',
});
const WITHDRAW_BODY_DESCRIPTOR = msg({
	message: 'We refund {amount} to your original payment method.',
	comment:
		'Sentence in the withdrawal dialog. {amount} is a price with currency. "Withdraw" means using the EU consumer right of withdrawal on a paid Operator Pass purchase that was not delivered yet, for a full refund. Never a word for taking money out.',
});
const WITHDRAW_OPEN_UNTIL_DESCRIPTOR = msg({
	message: 'Open until {date}.',
	comment:
		'Line in the dialog that withdraws from a paid Operator Pass purchase that was not delivered yet. It is the last day the withdrawal can be sent. {date} is a date without a time, such as Dec 4, 2026.',
});
const WITHDRAW_DONATION_DESCRIPTOR = msg({
	message: 'Your monthly donation is separate and keeps running.',
	comment:
		'Note in the Operator Pass withdrawal dialog, shown only when the buyer added a monthly donation at checkout.',
});
const KEEP_PURCHASE_DESCRIPTOR = msg({
	message: 'Keep purchase',
	comment:
		'Button that closes the withdrawal dialog without withdrawing. "Withdraw" means using the EU consumer right of withdrawal on a paid Operator Pass purchase that was not delivered yet, for a full refund. Never a word for taking money out.',
});
const CONFIRM_WITHDRAWAL_DESCRIPTOR = msg({
	message: 'Confirm withdrawal',
	comment:
		'Button that sends the withdrawal. Statutory wording from EU consumer law (Directive 2023/2673, article 11a, the confirmation function). Use the exact words of your language version of the directive if it has one (sv-SE: Bekräfta frånträde), otherwise translate the English faithfully. "Withdraw" means using the EU consumer right of withdrawal on a paid Operator Pass purchase that was not delivered yet, for a full refund. Never a word for taking money out.',
});
const WITHDRAWN_TOAST_DESCRIPTOR = msg({
	message: 'Withdrawal confirmed. We emailed you a receipt.',
	comment:
		'Toast after the withdrawal went through. "Withdraw" means using the EU consumer right of withdrawal on a paid Operator Pass purchase that was not delivered yet, for a full refund. Never a word for taking money out.',
});
const WITHDRAW_FAILED_DESCRIPTOR = msg({
	message: "Couldn't withdraw. Try again or contact support.",
	comment:
		'Error in the withdrawal dialog. "Withdraw" means using the EU consumer right of withdrawal on a paid Operator Pass purchase that was not delivered yet, for a full refund. Never a word for taking money out.',
});
const WITHDRAW_UNAVAILABLE_DESCRIPTOR = msg({
	message: "This can't be withdrawn here anymore. Contact support.",
	comment:
		'Error in the withdrawal dialog when the purchase changed, for example because it was delivered. "Withdraw" means using the EU consumer right of withdrawal on a paid Operator Pass purchase that was not delivered yet, for a full refund. Never a word for taking money out.',
});
const CANCEL_TITLE_DESCRIPTOR = msg({
	message: 'Cancel this pass?',
	comment:
		'Title of the dialog where a buyer in Brazil cancels one Operator Pass. "Cancel" means using the Brazilian right to withdraw from one Operator Pass within 7 days for a full refund (pt-BR: desistir, desistência).',
});
const CANCEL_BODY_DESCRIPTOR = msg({
	message: 'You get a full refund to your original payment method, and the pass ends now.',
	comment:
		'Sentence in the Brazil cancel dialog. "Cancel" means using the Brazilian right to withdraw from one Operator Pass within 7 days for a full refund (pt-BR: desistir, desistência).',
});
const CANCEL_LAST_PASS_DESCRIPTOR = msg({
	message: 'Your badge and wall listing go too.',
	comment:
		'Sentence in the Brazil cancel dialog, shown only when this is the last Operator Pass on the account. The badge is the Operator badge on the profile, the wall listing is the spot on the Operators\' wall. "Cancel" means using the Brazilian right to withdraw from one Operator Pass within 7 days for a full refund (pt-BR: desistir, desistência).',
});
const KEEP_PASS_DESCRIPTOR = msg({
	message: 'Keep pass',
	comment:
		'Button that closes the Brazil cancel dialog without canceling. "Cancel" means using the Brazilian right to withdraw from one Operator Pass within 7 days for a full refund (pt-BR: desistir, desistência).',
});
const CANCEL_PASS_DESCRIPTOR = msg({
	message: 'Cancel pass',
	comment:
		'Button that sends the cancellation of one Operator Pass bought in Brazil. "Cancel" means using the Brazilian right to withdraw from one Operator Pass within 7 days for a full refund (pt-BR: desistir, desistência).',
});
const CANCELED_TOAST_DESCRIPTOR = msg({
	message: 'Pass canceled. We emailed you a receipt.',
	comment:
		'Toast after the Brazil cancellation went through. "Cancel" means using the Brazilian right to withdraw from one Operator Pass within 7 days for a full refund (pt-BR: desistir, desistência).',
});
const CANCEL_FAILED_DESCRIPTOR = msg({
	message: "Couldn't cancel. Try again or contact support.",
	comment:
		'Error in the Brazil cancel dialog. "Cancel" means using the Brazilian right to withdraw from one Operator Pass within 7 days for a full refund (pt-BR: desistir, desistência).',
});
const CANCEL_UNAVAILABLE_DESCRIPTOR = msg({
	message: "This can't be canceled here anymore. Contact support.",
	comment:
		'Error in the Brazil cancel dialog when the 7 days have passed or the pass changed. "Cancel" means using the Brazilian right to withdraw from one Operator Pass within 7 days for a full refund (pt-BR: desistir, desistência).',
});
const FULL_NAME_DESCRIPTOR = msg({
	message: 'Full name',
	comment:
		'Label of the name field in the Operator Pass withdrawal and cancel dialogs. Consumer law asks for the name.',
});
const FULL_NAME_REQUIRED_DESCRIPTOR = msg({
	message: 'Enter your full name.',
	comment: 'Error under the name field of the Operator Pass withdrawal and cancel dialogs when it is empty.',
});

const WITHDRAWAL_NAME_INPUT_MAX_LENGTH = 200;

const logger = new Logger('OperatorPassWithdraw');

export type OperatorPassWithdrawTarget =
	| {kind: 'purchase'; purchase: OperatorPassPurchaseResponse; onWithdrawn: () => void}
	| {kind: 'pass'; pass: OperatorPassUnitResponse; lastPass: boolean};

const OperatorPassWithdrawModal = observer(function OperatorPassWithdrawModal({
	target,
}: {
	target: OperatorPassWithdrawTarget;
}) {
	const {i18n} = useLingui();
	const [name, setName] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [nameError, setNameError] = useState<string | undefined>(undefined);
	const [failure, setFailure] = useState<string | null>(null);
	const nameInputRef = useRef<HTMLInputElement | null>(null);
	const cancel = target.kind === 'pass';
	const targetId = target.kind === 'purchase' ? target.purchase.id : target.pass.id;
	const purchaseEndsAt = target.kind === 'purchase' ? target.purchase.withdrawal_ends_at : null;
	const purchaseEndsOn = target.kind === 'purchase' ? target.purchase.withdrawal_ends_on : null;
	const handleConfirm = async () => {
		const trimmedName = name.trim();
		if (!trimmedName) {
			setNameError(i18n._(FULL_NAME_REQUIRED_DESCRIPTOR));
			requestAnimationFrame(() => nameInputRef.current?.focus());
			return;
		}
		setNameError(undefined);
		setFailure(null);
		setSubmitting(true);
		try {
			if (target.kind === 'purchase') {
				await OperatorPassCommands.withdrawPurchase(target.purchase.id, {name: trimmedName});
				target.onWithdrawn();
			} else {
				await OperatorPassCommands.withdrawPass(target.pass.id, {name: trimmedName});
			}
			ToastCommands.success(i18n._(cancel ? CANCELED_TOAST_DESCRIPTOR : WITHDRAWN_TOAST_DESCRIPTOR));
			ModalCommands.pop();
		} catch (error) {
			logger.error('Operator Pass withdrawal failed', error);
			const unavailable =
				error instanceof HttpError && (error.status === HttpStatus.CONFLICT || error.status === HttpStatus.NOT_FOUND);
			let failureDescriptor = WITHDRAW_FAILED_DESCRIPTOR;
			if (cancel && unavailable) {
				failureDescriptor = CANCEL_UNAVAILABLE_DESCRIPTOR;
			} else if (cancel) {
				failureDescriptor = CANCEL_FAILED_DESCRIPTOR;
			} else if (unavailable) {
				failureDescriptor = WITHDRAW_UNAVAILABLE_DESCRIPTOR;
			}
			setFailure(i18n._(failureDescriptor));
			setSubmitting(false);
		}
	};
	return (
		<Modal.Root size="small" centered data-flx="premium.operator-pass-withdraw-modal.modal-root">
			<Modal.Header
				title={i18n._(cancel ? CANCEL_TITLE_DESCRIPTOR : WITHDRAW_TITLE_DESCRIPTOR)}
				data-flx="premium.operator-pass-withdraw-modal.modal-header"
			/>
			<Modal.Content data-flx="premium.operator-pass-withdraw-modal.modal-content">
				<Modal.ContentLayout data-flx="premium.operator-pass-withdraw-modal.content-layout">
					<Modal.Description data-flx="premium.operator-pass-withdraw-modal.body">
						{target.kind === 'pass'
							? i18n._(CANCEL_BODY_DESCRIPTOR)
							: i18n._(WITHDRAW_BODY_DESCRIPTOR, {
									amount: formatMinorUnitPrice(
										target.purchase.amount_minor,
										target.purchase.currency,
										getCurrentLocale(),
										OperatorPassCommands.getCountryCode(),
									),
								})}
					</Modal.Description>
					{purchaseEndsAt && (
						<p
							className={styles.note}
							title={formatOperatorPassDateTime(purchaseEndsAt)}
							data-flx="premium.operator-pass-withdraw-modal.open-until"
						>
							{i18n._(WITHDRAW_OPEN_UNTIL_DESCRIPTOR, {
								date: purchaseEndsOn
									? formatOperatorPassCalendarDay(purchaseEndsOn)
									: formatOperatorPassDate(purchaseEndsAt),
							})}
						</p>
					)}
					{target.kind === 'pass' && target.lastPass && (
						<p className={styles.note} data-flx="premium.operator-pass-withdraw-modal.last-pass">
							{i18n._(CANCEL_LAST_PASS_DESCRIPTOR)}
						</p>
					)}
					{target.kind === 'purchase' && target.purchase.has_donation && (
						<p className={styles.note} data-flx="premium.operator-pass-withdraw-modal.donation-note">
							{i18n._(WITHDRAW_DONATION_DESCRIPTOR)}
						</p>
					)}
					<Input
						ref={nameInputRef}
						id={`operator-pass-withdraw-name-${targetId}`}
						label={i18n._(FULL_NAME_DESCRIPTOR)}
						value={name}
						onChange={(event) => setName(event.target.value)}
						error={nameError}
						autoComplete="name"
						maxLength={WITHDRAWAL_NAME_INPUT_MAX_LENGTH}
						disabled={submitting}
						data-flx="premium.operator-pass-withdraw-modal.input.name"
					/>
					{failure && (
						<p className={styles.error} role="alert" data-flx="premium.operator-pass-withdraw-modal.error">
							{failure}
						</p>
					)}
				</Modal.ContentLayout>
			</Modal.Content>
			<Modal.Footer data-flx="premium.operator-pass-withdraw-modal.modal-footer">
				<Button
					variant="secondary"
					onClick={ModalCommands.pop}
					disabled={submitting}
					data-flx="premium.operator-pass-withdraw-modal.button.cancel"
				>
					{i18n._(cancel ? KEEP_PASS_DESCRIPTOR : KEEP_PURCHASE_DESCRIPTOR)}
				</Button>
				<Button
					variant="danger"
					onClick={() => void handleConfirm()}
					submitting={submitting}
					data-flx="premium.operator-pass-withdraw-modal.button.withdraw"
				>
					{i18n._(cancel ? CANCEL_PASS_DESCRIPTOR : CONFIRM_WITHDRAWAL_DESCRIPTOR)}
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});

export function openOperatorPassWithdrawModal(target: OperatorPassWithdrawTarget): void {
	ModalCommands.push(
		modal(() => <OperatorPassWithdrawModal target={target} data-flx="premium.operator-pass-withdraw-modal.open" />),
	);
}
