import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  validateEvidence,
  validateSupplierFacts,
  validateTenderRequirements,
} from "../packages/extraction/src/evidence.ts";
import {
  SupplierFactsSchema,
  TenderRequirementsSchema,
} from "../packages/extraction/src/schema.ts";
import { extractPdf } from "../packages/pdf/src/extract.ts";
import { fact, tenderFacts, voltlineFacts } from "./fixtures.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const pdf = (id: "tender" | "voltline") =>
  extractPdf(
    join(
      root,
      "datasets/electrical-installation/pdfs",
      id === "tender" ? "tender-request.pdf" : "voltline-proposal.pdf",
    ),
    id,
  );

describe("current extraction schemas and evidence", () => {
  it("requires nullable fields, ISO dates, and no model-generated issues", () => {
    const facts = voltlineFacts();
    expect(SupplierFactsSchema.safeParse({ ...facts, priceExGst: null }).success).toBe(true);
    expect(SupplierFactsSchema.safeParse({ ...facts, currency: undefined }).success).toBe(false);
    expect(SupplierFactsSchema.safeParse({ ...facts, identifiedIssues: [] }).success).toBe(false);
    expect(
      SupplierFactsSchema.safeParse({
        ...facts,
        contractorLicence: fact("null", "voltline", 2, "null"),
      }).success,
    ).toBe(false);
    expect(TenderRequirementsSchema.safeParse(tenderFacts).success).toBe(true);
    expect(
      TenderRequirementsSchema.safeParse({
        ...tenderFacts,
        closingDate: fact(
          "13 November 2026",
          "tender",
          1,
          "Tender closes: 13 November 2026 at 4:00 pm AWST.",
        ),
      }).success,
    ).toBe(false);
  });

  it("checks the cited document, page, and exact quotation with whitespace tolerance", async () => {
    const [supplier, tender] = await Promise.all([pdf("voltline"), pdf("tender")]);
    const facts = voltlineFacts();
    expect(validateSupplierFacts(facts, supplier).valid).toBe(true);
    expect(
      validateEvidence(
        { ...facts, priceExGst: fact(1_184_000, "voltline", 1, "Ex-GST  lump sum: AUD 1,184,000") },
        [supplier],
      ).valid,
    ).toBe(true);
    const wrongDocument = {
      ...facts,
      currency: fact(
        "AUD",
        "tender",
        1,
        "Submit one ex-GST lump sum in AUD and a week-by-week programme.",
      ),
    };
    expect(validateEvidence(wrongDocument, [supplier, tender]).errors).toContain(
      "extraction.currency.evidence[0]: supplier fact must cite supplier document voltline",
    );
    const wrongPage = {
      ...facts,
      insuranceEvidence: {
        ...facts.insuranceEvidence,
        workersCompensation: fact(
          { status: "attached" as const, policyId: "SYN-WC-101" },
          "voltline",
          3,
          "Workers compensation certificate: attached as a declared copy.",
        ),
      },
    };
    expect(validateSupplierFacts(wrongPage, supplier).errors).toContain(
      "extraction.insuranceEvidence.workersCompensation.evidence[0]: quotation does not occur on the cited page",
    );
    expect(supplier.pages[2]?.text).toContain(
      "Cover: workers compensation; synthetic policy SYN-WC-101.",
    );
  });

  it("rejects numeric and date values contradicted by real source quotes", async () => {
    const [supplier, tender] = await Promise.all([pdf("voltline"), pdf("tender")]);
    const facts = voltlineFacts();
    for (const [field, changed] of [
      ["priceExGst", { ...facts, priceExGst: { ...facts.priceExGst!, value: 1_000_000 } }],
      [
        "proposedDurationWeeks",
        { ...facts, proposedDurationWeeks: { ...facts.proposedDurationWeeks!, value: 16 } },
      ],
      [
        "warranty.months",
        {
          ...facts,
          warranty: { ...facts.warranty!, value: { ...facts.warranty!.value, months: 12 } },
        },
      ],
    ] as const) {
      expect(validateSupplierFacts(changed, supplier).errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `extraction.${field}: no supplier quotation supports extracted numeric value`,
          ),
        ]),
      );
    }
    expect(
      validateSupplierFacts(
        {
          ...facts,
          programmeCompletionDate: { ...facts.programmeCompletionDate!, value: "2027-05-28" },
        },
        supplier,
      ).errors,
    ).toContain(
      "extraction.programmeCompletionDate: cited quotation does not support the extracted date",
    );
    expect(
      validateTenderRequirements(
        {
          ...tenderFacts,
          requiredPracticalCompletionDate: {
            ...tenderFacts.requiredPracticalCompletionDate!,
            value: "2027-05-27",
          },
        },
        tender,
      ).errors,
    ).toContain(
      "requirements.requiredPracticalCompletionDate: cited quotation does not support the extracted date",
    );
    expect(
      validateTenderRequirements(
        {
          ...tenderFacts,
          tenderId: fact("NQTC-ELEC-2026-01", "voltline", 1, "Tender ID: NQTC-ELEC-2026-01."),
        },
        tender,
      ).valid,
    ).toBe(false);
  });

  it("associates certificate claims with the named insurance and rejects negated cover", async () => {
    const supplier = await pdf("voltline");
    const facts = voltlineFacts();
    const validate = (
      kind: "publicLiability" | "workersCompensation",
      status: "attached" | "claimed_only",
      quote: string,
    ) => {
      const page = supplier.pages.length + 1;
      const altered = {
        ...facts,
        insuranceEvidence: {
          ...facts.insuranceEvidence,
          [kind]: fact({ status, policyId: null }, "voltline", page, quote),
        },
      };
      return validateSupplierFacts(altered, {
        ...supplier,
        pages: [...supplier.pages, { page, text: quote }],
      });
    };
    for (const [kind, quote] of [
      [
        "publicLiability",
        "Public liability cover: AUD 20 million; Workers compensation certificate: attached.",
      ],
      [
        "workersCompensation",
        "Workers compensation cover: AUD 20 million; Public liability certificate: attached.",
      ],
    ] as const) {
      expect(validate(kind, "attached", quote).errors).toContain(
        `extraction.insuranceEvidence.${kind}.value.status: supplier quotations do not support attached`,
      );
      expect(validate(kind, "claimed_only", quote).valid).toBe(true);
    }
    for (const [kind, quote] of [
      ["publicLiability", "No public liability cover is maintained."],
      ["workersCompensation", "No workers compensation cover is maintained."],
    ] as const) {
      expect(validate(kind, "claimed_only", quote).errors).toContain(
        `extraction.insuranceEvidence.${kind}.value.status: supplier quotations do not support claimed_only`,
      );
    }
  });

  it("rejects contradictory statuses and coverage amounts used as policy IDs", async () => {
    const supplier = await pdf("voltline");
    const facts = voltlineFacts();
    const liability = facts.insuranceEvidence.publicLiability!;
    expect(validateSupplierFacts(facts, supplier).valid).toBe(true);
    for (const status of ["attached", "claimed_only"] as const) {
      expect(
        validateSupplierFacts(
          {
            ...facts,
            insuranceEvidence: {
              ...facts.insuranceEvidence,
              publicLiability: { ...liability, value: { status, policyId: null } },
            },
          },
          supplier,
        ).errors,
      ).toContain(
        `extraction.insuranceEvidence.publicLiability.value.status: supplier quotations do not support ${status}`,
      );
    }
    expect(
      validateSupplierFacts(
        {
          ...facts,
          insuranceEvidence: {
            ...facts.insuranceEvidence,
            publicLiability: {
              ...liability,
              value: { ...liability.value, policyId: "AUD 20 million" },
            },
          },
        },
        supplier,
      ).errors,
    ).toContain(
      "extraction.insuranceEvidence.publicLiability.value.policyId: no supplier quotation identifies AUD 20 million as a policy number",
    );
    const workers = facts.insuranceEvidence.workersCompensation!;
    expect(
      validateSupplierFacts(
        {
          ...facts,
          insuranceEvidence: {
            ...facts.insuranceEvidence,
            workersCompensation: {
              ...workers,
              value: { ...workers.value, status: "explicitly_missing" },
            },
          },
        },
        supplier,
      ).errors,
    ).toContain(
      "extraction.insuranceEvidence.workersCompensation.value.status: supplier quotations do not support explicitly_missing",
    );
  });
});
