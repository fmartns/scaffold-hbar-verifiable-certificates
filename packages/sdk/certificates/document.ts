/**
 * The human-readable certificate: a one-page PDF built only from data the holder accepts to make public (name, course,
 * issuer, date, certificate id). The grade and the student id stay in the credential, where the holder decides what
 * to disclose. The PDF is not the credential: it is a picture of it, bound to it by its SHA-256 (`document_sha256`).
 *
 * Rendering is deterministic (standard fonts, fixed dates, vector QR code), so the same input always gives the same
 * bytes and the same hash. That is what keeps a few KB small enough for HCS-1 (about 5 messages).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";

export interface CertificateDocumentInput {
  certificateId: string;
  holderName: string;
  course: string;
  issuerName: string;
  /** Issue date, `YYYY-MM-DD`. */
  issuedOn: string;
  /** Absolute URL the QR code opens (the public certificate page). */
  verificationUrl: string;
}

const PAGE: [number, number] = [842, 595]; // A4 landscape, points
const INK = rgb(0.11, 0.13, 0.22);
const ACCENT = rgb(0.2, 0.32, 0.62);

export async function renderCertificatePdf(input: CertificateDocumentInput): Promise<Uint8Array> {
  const issued = new Date(`${input.issuedOn}T00:00:00Z`);
  if (Number.isNaN(issued.getTime())) throw new TypeError("issuedOn must be a YYYY-MM-DD date.");

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${input.course} - Certificate of Completion`);
  pdf.setSubject(`Certificate ${input.certificateId}`);
  pdf.setCreator(input.issuerName);
  pdf.setProducer(input.issuerName);
  pdf.setCreationDate(issued);
  pdf.setModificationDate(issued);

  const page = pdf.addPage(PAGE);
  const [width] = PAGE;
  const serif = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const mono = await pdf.embedFont(StandardFonts.Courier);
  const centered = (text: string, y: number, font: typeof serif, size: number) =>
    page.drawText(text, { x: (width - font.widthOfTextAtSize(text, size)) / 2, y, font, size, color: INK });

  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: PAGE[1] - 48, borderColor: ACCENT, borderWidth: 3 });
  centered("Certificate of Completion", 470, bold, 36);
  centered(input.course, 410, serif, 28);
  centered("awarded to", 365, serif, 16);
  centered(input.holderName, 330, bold, 26);
  centered(`issued by ${input.issuerName} on ${input.issuedOn}`, 280, serif, 14);
  page.drawText(`Certificate ID ${input.certificateId}`, { x: 60, y: 72, font: mono, size: 9, color: INK });
  page.drawText("Scan to verify", { x: 60, y: 58, font: serif, size: 9, color: INK });

  // Vector QR code: one rectangle per dark module, so the document stays a few KB and renders sharply.
  const qr = QRCode.create(input.verificationUrl, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const module = 3;
  const left = width - 60 - size * module;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.modules.get(row, col)) {
        page.drawRectangle({
          x: left + col * module,
          y: 48 + (size - 1 - row) * module,
          width: module,
          height: module,
        });
      }
    }
  }

  return pdf.save({ useObjectStreams: true });
}
