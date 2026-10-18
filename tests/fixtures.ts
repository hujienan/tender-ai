import type { SupplierFacts, TenderRequirements } from "../packages/extraction/src/schema.ts";

export const source = (documentId: string, page: number, quote: string) => ({
  documentId,
  page,
  quote,
});
export const fact = <T>(value: T, documentId: string, page: number, quote: string) => ({
  value,
  evidence: [source(documentId, page, quote)],
});

// These cited facts are copied from the synthetic PDFs, not from archived model output.
const voltline: SupplierFacts = {
  supplierName: fact(
    "Voltline Projects Pty Ltd",
    "voltline",
    1,
    "Supplier: Voltline Projects Pty Ltd (fictional).",
  ),
  priceExGst: fact(
    1_184_000,
    "voltline",
    1,
    "Ex-GST lump sum: AUD 1,184,000; includes testing and as-built drawings.",
  ),
  currency: fact(
    "AUD",
    "voltline",
    1,
    "Ex-GST lump sum: AUD 1,184,000; includes testing and as-built drawings.",
  ),
  proposedDurationWeeks: fact(
    18,
    "voltline",
    1,
    "Proposed duration: 18 weeks from site access on 11 January 2027.",
  ),
  warranty: fact(
    { months: 24, conditions: "from practical completion" },
    "voltline",
    1,
    "Workmanship warranty: 24 months from practical completion.",
  ),
  programmeCompletionDate: fact(
    "2027-05-17",
    "voltline",
    2,
    "Programme milestone practical completion: 17 May 2027.",
  ),
  commercialCompletionDate: fact(
    "2027-05-21",
    "voltline",
    1,
    "Commercial offer completion date: 21 May 2027.",
  ),
  contractorLicence: fact(
    "SYN-EC-101",
    "voltline",
    2,
    "Electrical contractor licence: SYN-EC-101 (fictional training identifier).",
  ),
  supervisorQualification: fact(
    "Diploma of Electrical Engineering (2021)",
    "voltline",
    2,
    "Supervisor qualification: Diploma of Electrical Engineering (2021).",
  ),
  comparableReferences: [
    fact(
      "Eastbank Library upgrade (2024)",
      "voltline",
      2,
      "Comparable works: Eastbank Library upgrade (2024); Harbor Annex fit-out (2025).",
    ),
    fact(
      "Harbor Annex fit-out (2025)",
      "voltline",
      2,
      "Comparable works: Eastbank Library upgrade (2024); Harbor Annex fit-out (2025).",
    ),
  ],
  insuranceEvidence: {
    publicLiability: fact(
      { status: "explicitly_missing", policyId: null },
      "voltline",
      2,
      "Public liability cover: AUD 20 million; certificate not attached.",
    ),
    workersCompensation: {
      value: { status: "attached", policyId: "SYN-WC-101" },
      evidence: [
        source("voltline", 2, "Workers compensation certificate: attached as a declared copy."),
        source("voltline", 3, "Cover: workers compensation; synthetic policy SYN-WC-101."),
      ],
    },
  },
};

export function voltlineFacts(): SupplierFacts {
  return structuredClone(voltline);
}

export function voltlineWithUnsupportedPolicyId(): SupplierFacts {
  const facts = voltlineFacts();
  facts.insuranceEvidence.publicLiability!.value.policyId = "AUD 20 million";
  return facts;
}

export const tenderFacts: TenderRequirements = {
  tenderId: fact("NQTC-ELEC-2026-01", "tender", 1, "Tender ID: NQTC-ELEC-2026-01."),
  closingDate: fact("2026-11-13", "tender", 1, "Tender closes: 13 November 2026 at 4:00 pm AWST."),
  siteAccessDate: fact("2027-01-11", "tender", 1, "Anticipated site access: 11 January 2027."),
  requiredPracticalCompletionDate: fact(
    "2027-05-28",
    "tender",
    1,
    "Required practical completion: no later than 28 May 2027.",
  ),
  requiredCurrency: fact(
    "AUD",
    "tender",
    1,
    "Submit one ex-GST lump sum in AUD and a week-by-week programme.",
  ),
  minimumComparableReferences: fact(
    2,
    "tender",
    2,
    "Provide two comparable project references completed in the last five years.",
  ),
  publicLiabilityCertificateRequired: fact(
    true,
    "tender",
    2,
    "Attach current public liability and workers compensation insurance certificates.",
  ),
  workersCompensationCertificateRequired: fact(
    true,
    "tender",
    2,
    "Attach current public liability and workers compensation insurance certificates.",
  ),
};
