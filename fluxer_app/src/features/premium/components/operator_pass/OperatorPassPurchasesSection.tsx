// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/app/components/dialogs/components/plutonium/PurchaseHistorySection.module.css';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as OperatorPassCommands from '@app/features/premium/commands/OperatorPassCommands';
import {
	openOperatorPassWithdrawModal,
	WITHDRAW_FROM_CONTRACT_HERE_DESCRIPTOR,
} from '@app/features/premium/components/operator_pass/OperatorPassWithdrawModal';
import {PlutoniumPageButton} from '@app/features/premium/components/plutonium_page/PlutoniumPageButton';
import {formatOperatorPassDate, isOperatorPassAvailable} from '@app/features/premium/utils/OperatorPassUtils';
import type {OperatorPassPurchaseResponse} from '@fluxer/schema/src/domains/operator_pass/OperatorPassSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useCallback, useEffect, useState} from 'react';

export const UNDELIVERED_TITLE_DESCRIPTOR = msg({
	message: 'Operator Pass purchase',
	comment:
		'Title of a paid Operator Pass purchase that was not delivered yet, for example after a delivery error. Operator Pass is a product name.',
});
export const UNDELIVERED_LINE_DESCRIPTOR = msg({
	message: 'Paid {date}. Not delivered yet.',
	comment:
		'Line under a paid Operator Pass purchase that was not delivered yet. {date} is a date without a time, such as Nov 20, 2026.',
});

const logger = new Logger('OperatorPassPurchases');

export function useUndeliveredOperatorPassPurchases(): {
	purchases: ReadonlyArray<OperatorPassPurchaseResponse>;
	reload: () => void;
} {
	const [purchases, setPurchases] = useState<ReadonlyArray<OperatorPassPurchaseResponse>>([]);
	const reload = useCallback(() => {
		OperatorPassCommands.fetchPurchases()
			.then((result) => setPurchases(result.filter((purchase) => purchase.can_withdraw)))
			.catch((error) => logger.warn('Failed to load Operator Pass purchases', error));
	}, []);
	useEffect(() => {
		if (isOperatorPassAvailable()) reload();
	}, [reload]);
	return {purchases, reload};
}

export const OperatorPassPurchasesSection = observer(function OperatorPassPurchasesSection({
	className,
}: {
	className?: string;
}) {
	const {i18n} = useLingui();
	const {purchases, reload} = useUndeliveredOperatorPassPurchases();
	if (purchases.length === 0) return null;
	return (
		<section className={clsx(styles.section, className)} data-flx="premium.operator-pass-purchases-section.section">
			{purchases.map((purchase) => (
				<div key={purchase.id} className={styles.card} data-flx="premium.operator-pass-purchases-section.purchase">
					<div className={styles.grid} data-flx="premium.operator-pass-purchases-section.grid">
						<div className={styles.content} data-flx="premium.operator-pass-purchases-section.purchase-text">
							<h3 className={styles.title} data-flx="premium.operator-pass-purchases-section.heading">
								{i18n._(UNDELIVERED_TITLE_DESCRIPTOR)}
							</h3>
							{purchase.purchased_at && (
								<p className={styles.description} data-flx="premium.operator-pass-purchases-section.paid">
									{i18n._(UNDELIVERED_LINE_DESCRIPTOR, {date: formatOperatorPassDate(purchase.purchased_at)})}
								</p>
							)}
						</div>
						<PlutoniumPageButton
							variant="secondary"
							small
							className={styles.button}
							onClick={() => openOperatorPassWithdrawModal({kind: 'purchase', purchase, onWithdrawn: reload})}
							data-flx="premium.operator-pass-purchases-section.button.withdraw"
						>
							{i18n._(WITHDRAW_FROM_CONTRACT_HERE_DESCRIPTOR)}
						</PlutoniumPageButton>
					</div>
				</div>
			))}
		</section>
	);
});
