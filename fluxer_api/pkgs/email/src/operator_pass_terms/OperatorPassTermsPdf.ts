// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	getOperatorPassTermsBlocks,
	getOperatorPassTermsTitle,
	getOperatorPassTermsUrl,
	getOperatorPassTermsVersionLabel,
	getOperatorPassTraderLines,
	OPERATOR_PASS_TERMS_VERSION,
	type OperatorPassTermsLanguage,
	toPlainTermsText,
} from '@pkgs/email/src/operator_pass_terms/OperatorPassTerms';
import type {OperatorPassTermsBlock} from '@pkgs/email/src/operator_pass_terms/OperatorPassTermsText';
import {PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts} from 'pdf-lib';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BODY_SIZE = 10;
const LINE_GAP = 4;
const TEXT_COLOR = rgb(0.1, 0.1, 0.12);
const MUTED_COLOR = rgb(0.35, 0.35, 0.4);

interface TextStyle {
	font: PDFFont;
	size: number;
	color: ReturnType<typeof rgb>;
	indent: number;
	spaceBefore: number;
}

class PdfWriter {
	private page: PDFPage;
	private cursor: number;

	constructor(private readonly document: PDFDocument) {
		this.page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
		this.cursor = PAGE_HEIGHT - MARGIN;
	}

	write(text: string, style: TextStyle, firstLinePrefix = ''): void {
		const lineHeight = style.size + LINE_GAP;
		const width = CONTENT_WIDTH - style.indent;
		const lines = wrapText(
			text,
			style.font,
			style.size,
			width - style.font.widthOfTextAtSize(firstLinePrefix, style.size),
		);
		this.cursor -= style.spaceBefore;
		lines.forEach((line, index) => {
			if (this.cursor - lineHeight < MARGIN) {
				this.page = this.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
				this.cursor = PAGE_HEIGHT - MARGIN;
			}
			this.cursor -= lineHeight;
			const prefix = index === 0 ? firstLinePrefix : '';
			const prefixWidth = firstLinePrefix ? style.font.widthOfTextAtSize(firstLinePrefix, style.size) : 0;
			const x = MARGIN + style.indent + (index === 0 ? 0 : prefixWidth);
			this.page.drawText(`${prefix}${line}`, {
				x,
				y: this.cursor,
				size: style.size,
				font: style.font,
				color: style.color,
			});
		});
	}
}

function wrapText(text: string, font: PDFFont, size: number, width: number): Array<string> {
	const lines: Array<string> = [];
	let current = '';
	for (const word of text.split(/\s+/u).filter(Boolean)) {
		const candidate = current ? `${current} ${word}` : word;
		if (font.widthOfTextAtSize(candidate, size) <= width || !current) {
			current = candidate;
			continue;
		}
		lines.push(current);
		current = word;
	}
	if (current) {
		lines.push(current);
	}
	return lines;
}

function styleFor(block: OperatorPassTermsBlock, fonts: {regular: PDFFont; bold: PDFFont; italic: PDFFont}): TextStyle {
	switch (block.kind) {
		case 'heading':
			return {font: fonts.bold, size: 13, color: TEXT_COLOR, indent: 0, spaceBefore: 14};
		case 'subheading':
			return {font: fonts.bold, size: 11, color: TEXT_COLOR, indent: 0, spaceBefore: 10};
		case 'bullet':
			return {font: fonts.regular, size: BODY_SIZE, color: TEXT_COLOR, indent: 10, spaceBefore: 4};
		case 'quote':
			return {font: fonts.italic, size: BODY_SIZE, color: MUTED_COLOR, indent: 14, spaceBefore: 8};
		default:
			return {font: fonts.regular, size: BODY_SIZE, color: TEXT_COLOR, indent: 0, spaceBefore: 8};
	}
}

export function getOperatorPassTermsPdfFilename(language: OperatorPassTermsLanguage): string {
	return `fluxer-operator-pass-terms-${OPERATOR_PASS_TERMS_VERSION}-${language}.pdf`;
}

export async function renderOperatorPassTermsPdf(
	language: OperatorPassTermsLanguage,
	marketingBaseUrl: string,
): Promise<Uint8Array> {
	const document = await PDFDocument.create();
	const title = getOperatorPassTermsTitle(language);
	const issuedAt = new Date(`${OPERATOR_PASS_TERMS_VERSION}T00:00:00Z`);
	document.setTitle(`${title} (${OPERATOR_PASS_TERMS_VERSION})`);
	document.setAuthor('Fluxer Platform AB');
	document.setLanguage(language);
	document.setCreator('Fluxer');
	document.setProducer('Fluxer');
	document.setCreationDate(issuedAt);
	document.setModificationDate(issuedAt);
	const fonts = {
		regular: await document.embedFont(StandardFonts.Helvetica),
		bold: await document.embedFont(StandardFonts.HelveticaBold),
		italic: await document.embedFont(StandardFonts.HelveticaOblique),
	};
	const writer = new PdfWriter(document);
	writer.write(title, {font: fonts.bold, size: 18, color: TEXT_COLOR, indent: 0, spaceBefore: 0});
	writer.write(getOperatorPassTermsVersionLabel(language), {
		font: fonts.regular,
		size: BODY_SIZE,
		color: MUTED_COLOR,
		indent: 0,
		spaceBefore: 6,
	});
	writer.write(getOperatorPassTermsUrl(marketingBaseUrl), {
		font: fonts.regular,
		size: BODY_SIZE,
		color: MUTED_COLOR,
		indent: 0,
		spaceBefore: 2,
	});
	for (const block of getOperatorPassTermsBlocks(language)) {
		const style = styleFor(block, fonts);
		writer.write(toPlainTermsText(block.text, marketingBaseUrl), style, block.kind === 'bullet' ? '• ' : '');
	}
	const traderStyle = {font: fonts.regular, size: BODY_SIZE, color: MUTED_COLOR, indent: 0, spaceBefore: 2};
	getOperatorPassTraderLines(language).forEach((line, index) => {
		writer.write(line, {...traderStyle, spaceBefore: index === 0 ? 18 : 2});
	});
	return document.save({useObjectStreams: false});
}
