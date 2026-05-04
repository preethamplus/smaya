// Generates 10 real PDF resumes from fixtures/resumes/resumes.json.
// Run:  node scripts/generate-resumes.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import PDFDocument from "pdfkit";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "fixtures/resumes/resumes.json");
const OUT_DIR = join(ROOT, "fixtures/resumes/pdf");
mkdirSync(OUT_DIR, { recursive: true });

const resumes = JSON.parse(readFileSync(SRC, "utf8"));

for (const r of resumes) {
  const path = join(OUT_DIR, `${r.id}-${r.name.replace(/\s+/g, "_")}.pdf`);
  await renderOne(r, path);
  console.log("wrote", path);
}

async function renderOne(r, path) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => {
      writeFileSync(path, Buffer.concat(chunks));
      resolve();
    });
    doc.on("error", reject);

    doc.fontSize(20).font("Helvetica-Bold").text(r.name);
    doc.moveDown(0.2);
    doc.fontSize(10).font("Helvetica").text(
      `${r.email} · ${r.phone} · ${r.location}`
    );
    doc.text(`${r.linkedin} · ${r.github}`);
    doc.moveDown();

    section(doc, "Summary");
    doc.fontSize(10).font("Helvetica").text(r.summary);
    doc.moveDown();

    section(doc, "Skills");
    doc.fontSize(10).font("Helvetica").text(r.skills.join(", "));
    doc.moveDown();

    section(doc, "Experience");
    for (const e of r.experience) {
      doc.fontSize(11).font("Helvetica-Bold").text(`${e.role} — ${e.company}`);
      doc.fontSize(9).font("Helvetica-Oblique").text(e.years);
      doc.fontSize(10).font("Helvetica");
      for (const h of e.highlights) doc.text(`• ${h}`);
      doc.moveDown(0.5);
    }

    section(doc, "Education");
    for (const ed of r.education) {
      doc.fontSize(10).font("Helvetica").text(
        `${ed.degree}, ${ed.school} (${ed.year})`
      );
    }

    doc.end();
  });
}

function section(doc, title) {
  doc.fontSize(13).font("Helvetica-Bold").fillColor("#1f3b5b").text(title);
  doc.fillColor("black");
  doc.moveDown(0.2);
}
