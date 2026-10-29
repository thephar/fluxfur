// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/premium/components/modals/OperatorPassCheckoutModal.module.css';
import {OperatorPassWallNameField} from '@app/features/premium/components/operator_pass/OperatorPassWallNameField';
import {
	getOperatorPassWallNameProblem,
	type OperatorPassWallNameProblem,
} from '@app/features/premium/utils/OperatorPassUtils';
import {Checkbox} from '@app/features/ui/checkbox/Checkbox';
import {clsx} from 'clsx';
import {makeAutoObservable} from 'mobx';
import type {ReactNode} from 'react';

export const WALL_NAME_FIELD_ID = 'operator-pass-checkout-wall-name';
export const WAIVER_BOX_ID = 'operator-pass-checkout-waiver';
export const AGE_BOX_ID = 'operator-pass-checkout-age';

export class OperatorPassCheckoutDraft {
	wallName: string;
	wallOptOut = false;
	wallNameProblem: OperatorPassWallNameProblem | null = null;
	waiver = false;
	ageConfirmed = false;
	waiverMissing = false;
	ageMissing = false;
	revealWallField = false;

	constructor(wallName: string) {
		this.wallName = wallName;
		makeAutoObservable(this, {}, {autoBind: true});
	}

	setWallName(value: string): void {
		this.wallName = value;
	}
	setWallOptOut(value: boolean): void {
		this.wallOptOut = value;
	}
	setWallNameProblem(value: OperatorPassWallNameProblem | null): void {
		this.wallNameProblem = value;
	}
	setWaiver(value: boolean): void {
		this.waiver = value;
	}
	setAgeConfirmed(value: boolean): void {
		this.ageConfirmed = value;
	}
	setWaiverMissing(value: boolean): void {
		this.waiverMissing = value;
	}
	setAgeMissing(value: boolean): void {
		this.ageMissing = value;
	}
	setRevealWallField(value: boolean): void {
		this.revealWallField = value;
	}

	resetConsents(): void {
		this.waiver = false;
		this.ageConfirmed = false;
		this.waiverMissing = false;
		this.ageMissing = false;
	}
}

interface OperatorPassCheckoutFormProps {
	draft: OperatorPassCheckoutDraft;
	values: Pick<
		OperatorPassCheckoutDraft,
		'wallName' | 'wallOptOut' | 'wallNameProblem' | 'waiver' | 'ageConfirmed' | 'waiverMissing' | 'ageMissing'
	>;
	asksWallChoice: boolean;
	quantity: number;
	submitting: boolean;
	listingUnchanged: ReactNode;
	waiverLabel: ReactNode;
	waiverError: ReactNode;
	ageLabel: ReactNode;
	ageError: ReactNode;
}

export function OperatorPassCheckoutForm({
	draft,
	values,
	asksWallChoice,
	quantity,
	submitting,
	listingUnchanged,
	waiverLabel,
	waiverError,
	ageLabel,
	ageError,
}: OperatorPassCheckoutFormProps) {
	const {wallName, wallOptOut, wallNameProblem, waiver, ageConfirmed, waiverMissing, ageMissing} = values;
	const {setWallName, setWallOptOut, setWallNameProblem, setWaiver, setAgeConfirmed, setWaiverMissing, setAgeMissing} =
		draft;
	return (
		<>
			{!asksWallChoice ? (
				listingUnchanged
			) : (
				<OperatorPassWallNameField
					id={WALL_NAME_FIELD_ID}
					name={wallName}
					optOut={wallOptOut}
					problem={wallNameProblem}
					disabled={submitting}
					context="checkout"
					onNameChange={(value) => {
						setWallName(value);
						if (wallNameProblem) {
							setWallNameProblem(getOperatorPassWallNameProblem(value, wallOptOut));
						}
					}}
					onOptOutChange={(value) => {
						setWallOptOut(value);
						if (value) {
							setWallNameProblem(null);
						}
					}}
					data-flx="premium.operator-pass-checkout-modal.render-purchase.operator-pass-wall-name-field"
				/>
			)}
			<div
				id={WAIVER_BOX_ID}
				className={clsx(styles.consentBox, waiverMissing && styles.consentBoxError)}
				data-flx="premium.operator-pass-checkout-modal.waiver"
			>
				<Checkbox
					className={styles.consentCheckbox}
					checked={waiver}
					onChange={(value) => {
						setWaiver(value);
						if (value) {
							setWaiverMissing(false);
						}
					}}
					disabled={submitting}
					aria-describedby={waiverMissing ? 'operator-pass-checkout-waiver-error' : undefined}
					data-flx="premium.operator-pass-checkout-modal.checkbox.waiver"
				>
					{waiverLabel}
				</Checkbox>
				{waiverError}
			</div>
			{quantity > 1 && (
				<div
					id={AGE_BOX_ID}
					className={clsx(styles.consentBox, ageMissing && styles.consentBoxError)}
					data-flx="premium.operator-pass-checkout-modal.age"
				>
					<Checkbox
						className={styles.consentCheckbox}
						checked={ageConfirmed}
						onChange={(value) => {
							setAgeConfirmed(value);
							if (value) {
								setAgeMissing(false);
							}
						}}
						disabled={submitting}
						aria-describedby={ageMissing ? 'operator-pass-checkout-age-error' : undefined}
						data-flx="premium.operator-pass-checkout-modal.checkbox.age"
					>
						{ageLabel}
					</Checkbox>
					{ageError}
				</div>
			)}
		</>
	);
}
