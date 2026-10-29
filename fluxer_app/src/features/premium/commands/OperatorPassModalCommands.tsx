// SPDX-License-Identifier: AGPL-3.0-or-later

import {OperatorPassCheckoutModal} from '@app/features/premium/components/modals/OperatorPassCheckoutModal';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';

const CHECKOUT_MODAL_KEY = 'operator-pass-checkout';

let checkoutModalMount = 0;

export function openCheckoutModal({canceled = false}: {canceled?: boolean} = {}): void {
	const mount = ++checkoutModalMount;
	ModalCommands.pushWithKey(
		modal(() => (
			<OperatorPassCheckoutModal
				key={mount}
				canceled={canceled}
				data-flx="premium.operator-pass-modal-commands.open-checkout-modal.operator-pass-checkout-modal"
			/>
		)),
		CHECKOUT_MODAL_KEY,
	);
}

export function reopenCheckoutModalAfterReturn(): void {
	const topModalKey = ModalCommands.getTopModalKey();
	if (topModalKey !== null && topModalKey !== CHECKOUT_MODAL_KEY) return;
	openCheckoutModal();
}
