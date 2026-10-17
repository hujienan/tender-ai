import type { ExtractedPdf } from "../../pdf/src/extract.ts";
import type { Evidence, SupplierExtraction, SupplierFacts, TenderRequirements } from "./schema.ts";

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

// shortcut: Date checks use the synthetic PDFs' English date labels; extend for other source formats.
function supportsDate(value: string, evidence: Evidence[], documentId: string, pattern: RegExp) {
  return evidence.some((citation) => {
    if (citation.documentId !== documentId) return false;
    const match = normalise(citation.quote).match(pattern);
    if (!match?.[1]) return false;
    const parts = match[1].match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
    if (!parts) return false;
    const month = months.indexOf(parts[2]!.toLowerCase()) + 1;
    return (
      month > 0 &&
      `${parts[3]}-${String(month).padStart(2, "0")}-${parts[1]!.padStart(2, "0")}` === value
    );
  });
}

export function validateEvidence(
  extraction: SupplierExtraction | SupplierFacts,
  documents: ExtractedPdf[],
) {
  const supplierDocumentId = documents[0]?.documentId;
  const pages = new Map(
    documents.map((document) => [
      document.documentId,
      new Map(document.pages.map((page) => [page.page, page.text])),
    ]),
  );
  const errors: string[] = [];
  if (!supplierDocumentId) errors.push("Supplier document is missing.");

  function check(citation: Evidence, path: string, allowTender: boolean) {
    const document = pages.get(citation.documentId);
    if (!document) {
      errors.push(`${path}: unknown document ID ${citation.documentId}`);
      return;
    }
    if (!allowTender && citation.documentId !== supplierDocumentId) {
      errors.push(`${path}: supplier fact must cite supplier document ${supplierDocumentId}`);
    }
    const page = document.get(citation.page);
    const quote = normalise(citation.quote);
    if (page === undefined) {
      errors.push(`${path}: page ${citation.page} does not exist`);
    } else if (!quote || !normalise(page).includes(quote)) {
      errors.push(`${path}: quotation does not occur on the cited page`);
    }
  }

  function visit(value: unknown, path: string, allowTender: boolean) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, allowTender));
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "evidence" && Array.isArray(child)) {
          child.forEach((citation, index) =>
            check(citation as Evidence, `${path}.evidence[${index}]`, allowTender),
          );
        } else {
          visit(child, `${path}.${key}`, allowTender);
        }
      }
    }
  }

  for (const [field, value] of Object.entries(extraction)) {
    visit(value, `extraction.${field}`, field === "identifiedIssues");
  }

  // shortcut: Numeric checks use the synthetic PDFs' field labels; expand parsing for real supplier formats.
  function checkNumber(
    path: string,
    value: number | null | undefined,
    evidence: Evidence[] | undefined,
    pattern: RegExp,
  ) {
    if (value == null) return;
    if (
      !evidence?.some(
        (citation) =>
          citation.documentId === supplierDocumentId &&
          [...normalise(citation.quote).matchAll(pattern)].some(
            (match) => Number(match[1]?.replaceAll(",", "")) === value,
          ),
      )
    ) {
      errors.push(`${path}: no supplier quotation supports extracted numeric value ${value}`);
    }
  }

  checkNumber(
    "extraction.priceExGst",
    extraction.priceExGst?.value,
    extraction.priceExGst?.evidence,
    /\bEx-GST lump sum:\s*[A-Z]{3}\s+(\d[\d,]*(?:\.\d+)?)\b/gi,
  );
  checkNumber(
    "extraction.proposedDurationWeeks",
    extraction.proposedDurationWeeks?.value,
    extraction.proposedDurationWeeks?.evidence,
    /\bProposed duration:\s*(\d+)\s+weeks?\b/gi,
  );
  checkNumber(
    "extraction.warranty.months",
    extraction.warranty?.value.months,
    extraction.warranty?.evidence,
    /\b(?:Workmanship warranty|Warranty):\s*(\d+)\s+months?\b/gi,
  );

  // shortcut: Synthetic policy IDs are single tokens; broaden parsing for real certificate formats.
  for (const [kind, insurance] of Object.entries(extraction.insuranceEvidence)) {
    const policyId = insurance?.value.policyId;
    if (!insurance || policyId == null) continue;
    const labelledPolicy =
      /\b(?:policy(?:\s+(?:number|no\.?|id))?|certificate\s+(?:number|no\.?|id))\s*[:#]?\s*([A-Z0-9][A-Z0-9/-]*)\b/gi;
    if (
      !insurance.evidence.some(
        (citation) =>
          citation.documentId === supplierDocumentId &&
          [...normalise(citation.quote).matchAll(labelledPolicy)].some(
            (match) => match[1]?.toLowerCase() === policyId.toLowerCase(),
          ),
      )
    ) {
      errors.push(
        `extraction.insuranceEvidence.${kind}.value.policyId: no supplier quotation identifies ${policyId} as a policy number`,
      );
    }
  }

  // shortcut: Status checks recognise explicit certificate statements; other wording requires review.
  for (const [kind, insurance] of Object.entries(extraction.insuranceEvidence)) {
    if (!insurance) continue;
    const label = kind === "publicLiability" ? "public liability" : "workers compensation";
    const statements = insurance.evidence
      .filter((citation) => citation.documentId === supplierDocumentId)
      .flatMap((citation) => {
        let subject: string | null = null;
        return normalise(citation.quote)
          .toLowerCase()
          .split(/;\s*|[.!?]\s+/)
          .flatMap((statement) => {
            const publicLiability = /\bpublic liability\b/.test(statement);
            const workersCompensation = /\bworkers compensation\b/.test(statement);
            if (publicLiability || workersCompensation) {
              subject =
                publicLiability === workersCompensation
                  ? null
                  : publicLiability
                    ? "public liability"
                    : "workers compensation";
            }
            return subject === label ? [statement] : [];
          });
      });
    const attached = statements.some((statement) =>
      /\bcertificate\s*(?::\s*|is\s+)?attached\b/.test(statement),
    );
    const missing = statements.some((statement) =>
      /\bcertificate\b[^.]*\b(?:not attached|not included|missing|absent)\b|\b(?:no|without(?: an?)?)\s+certificate\b/.test(
        statement,
      ),
    );
    const claimed = statements.some(
      (statement) =>
        /\b(?:cover|coverage|policy|insurance)\b/.test(statement) &&
        /\b(?:[1-9][\d,]*(?:\.\d+)?|maintained|held|provided|current|active|in force)\b/.test(
          statement,
        ) &&
        !/\b(?:no|not|none|nil|without|lacks?|lacking|absent|missing)\b/.test(statement),
    );
    const status = insurance.value.status;
    const supported =
      status === "attached"
        ? attached && !missing
        : status === "explicitly_missing"
          ? missing && !attached
          : claimed && !attached && !missing;
    if (!supported) {
      errors.push(
        `extraction.insuranceEvidence.${kind}.value.status: supplier quotations do not support ${status}`,
      );
    }
  }

  if (
    "identifiedIssues" in extraction &&
    extraction.insuranceEvidence.publicLiability?.value.status === "explicitly_missing" &&
    !extraction.identifiedIssues.some(
      (issue) =>
        issue.type === "missing_evidence" &&
        /\bpublic liability\b/i.test(
          [issue.description, ...issue.evidence.map((citation) => citation.quote)].join(" "),
        ),
    )
  ) {
    errors.push(
      "Missing public liability certificate was not identified as a missing_evidence issue.",
    );
  }

  const programme = extraction.programmeCompletionDate?.value;
  const commercial = extraction.commercialCompletionDate?.value;
  if (
    "identifiedIssues" in extraction &&
    programme &&
    commercial &&
    programme !== commercial &&
    !extraction.identifiedIssues.some((issue) => issue.type === "conflicting_dates")
  ) {
    errors.push("Conflicting completion dates were not identified as an issue.");
  }

  return { valid: errors.length === 0, errors };
}

export function validateSupplierFacts(facts: SupplierFacts, document: ExtractedPdf) {
  const errors = validateEvidence(facts, [document]).errors;
  for (const [path, fact] of [
    ["supplierName", facts.supplierName],
    ["currency", facts.currency],
    ["contractorLicence", facts.contractorLicence],
    ["supervisorQualification", facts.supervisorQualification],
    ...facts.comparableReferences.map(
      (entry, index) => [`comparableReferences[${index}]`, entry] as const,
    ),
  ] as const) {
    if (
      fact &&
      !fact.evidence.some(
        (citation) =>
          citation.documentId === document.documentId &&
          normalise(citation.quote).toLowerCase().includes(normalise(fact.value).toLowerCase()),
      )
    ) {
      errors.push(`extraction.${path}: cited quotation does not state the extracted value`);
    }
  }
  for (const [path, fact, pattern] of [
    [
      "programmeCompletionDate",
      facts.programmeCompletionDate,
      /\b(?:Programme milestone practical completion|Target practical completion):\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/i,
    ],
    [
      "commercialCompletionDate",
      facts.commercialCompletionDate,
      /\bCommercial offer completion date:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/i,
    ],
  ] as const) {
    if (fact && !supportsDate(fact.value, fact.evidence, document.documentId, pattern)) {
      errors.push(`extraction.${path}: cited quotation does not support the extracted date`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateTenderRequirements(
  requirements: TenderRequirements,
  document: ExtractedPdf,
) {
  const errors: string[] = [];
  for (const [field, fact] of Object.entries(requirements)) {
    if (!fact) continue;
    for (const [index, citation] of fact.evidence.entries()) {
      const path = `requirements.${field}.evidence[${index}]`;
      if (citation.documentId !== document.documentId) {
        errors.push(`${path}: fact must cite source document ${document.documentId}`);
      }
      const page = document.pages.find((entry) => entry.page === citation.page);
      const quote = normalise(citation.quote);
      if (!page) errors.push(`${path}: page ${citation.page} does not exist`);
      else if (!quote || !normalise(page.text).includes(quote)) {
        errors.push(`${path}: quotation does not occur on the cited page`);
      }
    }
  }
  for (const [path, fact, pattern] of [
    [
      "closingDate",
      requirements.closingDate,
      /\bTender closes:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/i,
    ],
    [
      "siteAccessDate",
      requirements.siteAccessDate,
      /\bAnticipated site access:\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/i,
    ],
    [
      "requiredPracticalCompletionDate",
      requirements.requiredPracticalCompletionDate,
      /\bRequired practical completion:\s*no later than\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\b/i,
    ],
  ] as const) {
    if (fact && !supportsDate(fact.value, fact.evidence, document.documentId, pattern)) {
      errors.push(`requirements.${path}: cited quotation does not support the extracted date`);
    }
  }
  for (const [path, fact, label] of [
    [
      "publicLiabilityCertificateRequired",
      requirements.publicLiabilityCertificateRequired,
      "public liability",
    ],
    [
      "workersCompensationCertificateRequired",
      requirements.workersCompensationCertificateRequired,
      "workers compensation",
    ],
  ] as const) {
    if (!fact) continue;
    const supported = fact.evidence.some((citation) => {
      if (citation.documentId !== document.documentId) return false;
      const quote = normalise(citation.quote).toLowerCase();
      return (
        quote.includes(label) &&
        (fact.value
          ? /\b(?:attach|provide|required|mandatory)\b/.test(quote)
          : /\b(?:optional|not required)\b/.test(quote))
      );
    });
    if (!supported)
      errors.push(`requirements.${path}: cited quotation does not support the requirement`);
  }
  for (const [path, fact] of [
    ["tenderId", requirements.tenderId],
    ["requiredCurrency", requirements.requiredCurrency],
  ] as const) {
    if (
      fact &&
      !fact.evidence.some(
        (citation) =>
          citation.documentId === document.documentId &&
          normalise(citation.quote).includes(fact.value),
      )
    ) {
      errors.push(`requirements.${path}: cited quotation does not state the extracted value`);
    }
  }
  const references = requirements.minimumComparableReferences;
  if (references) {
    const words = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
    ];
    const supported = references.evidence.some((citation) => {
      if (citation.documentId !== document.documentId) return false;
      const match = normalise(citation.quote).match(
        /\bProvide\s+(\w+)\s+comparable project references\b/i,
      );
      const count = match?.[1]?.toLowerCase();
      return (
        count !== undefined &&
        (Number(count) === references.value || words.indexOf(count) === references.value)
      );
    });
    if (!supported)
      errors.push(
        "requirements.minimumComparableReferences: cited quotation does not support the count",
      );
  }
  return { valid: errors.length === 0, errors };
}
