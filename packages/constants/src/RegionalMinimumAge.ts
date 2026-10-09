// SPDX-License-Identifier: AGPL-3.0-or-later

const DEFAULT_MINIMUM_AGE = 18;

const REGIONAL_MINIMUM_AGE: Readonly<Record<string, number>> = {
	AT: 18,
	AW: 18,
	BG: 18,
	BQ: 18,
	CL: 18,
	CO: 18,
	CW: 18,
	CY: 18,
	CZ: 18,
	DE: 18,
	ES: 18,
	FR: 18,
	GR: 18,
	HR: 18,
	HU: 18,
	IE: 18,
	IT: 18,
	KR: 18,
	LT: 18,
	LU: 18,
	NL: 18,
	PE: 18,
	PL: 18,
	RO: 18,
	RS: 18,
	SI: 18,
	SK: 18,
	SM: 18,
	SX: 18,
	VE: 18,
	VN: 18,
};

export function getRegionalMinimumAge(countryCode: string | null | undefined): number {
	const normalized = countryCode?.trim().toUpperCase();
	return (normalized && REGIONAL_MINIMUM_AGE[normalized]) || DEFAULT_MINIMUM_AGE;
}
