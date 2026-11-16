/**
 * Builds a small, valid, single-page PDF containing the given text lines.
 * Hand-assembled so tests need no fixture file and the content is fully known.
 */
export function syntheticPdf(lines: string[], title = 'Synthetic Test Document'): ArrayBuffer {
  const esc = (t: string) => t.replace(/[\\()]/g, '\\$&');
  const body = lines
    .map((l, i) => `BT /F1 10 Tf 40 ${760 - i * 14} Td (${esc(l)}) Tj ET`)
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Title (${esc(title)}) >>`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF`;

  const bytes = Buffer.from(pdf, 'latin1');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** ~45 distinct lines (several chunks' worth) tagged so each revision differs. */
export function syntheticLines(tag: string, count = 45): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `Section ${i + 1} of synthetic regression document ${tag}: applicants should confirm eligibility details with staff before enrolling in program ${tag}-${i}.`,
  );
}
