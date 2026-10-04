// The only details we ask for. Everything else (what the business offers,
// its reputation, its nearby competitors) is found by the research.

// The AI employees the report covers. To cover another AI employee, add an
// entry here and a matching brief in prompts.js (ROLE_BRIEFS).
export const AI_EMPLOYEES = {
  receptionist: "AI Receptionist (Webchat, Voice & SMS)",
  social_media: "AI Social Media",
  blogger: "AI Blogger",
};

const FIELDS = {
  businessName: { label: "Business name", max: 200 },
  website: { label: "Website", max: 500 },
  category: { label: "Business category", max: 200 },
  city: { label: "City", max: 120 },
};

export function normalizeWebsite(raw) {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value); // throws on garbage
  if (!url.hostname.includes(".")) throw new Error("Website must include a domain, e.g. example.com");
  return url.toString();
}

// Returns { intake } on success or { errors } listing what is wrong.
export function validateIntake(body) {
  const errors = [];
  const intake = {};

  for (const [key, spec] of Object.entries(FIELDS)) {
    const value = typeof body?.[key] === "string" ? body[key].trim() : "";
    if (!value) errors.push(`${spec.label} is required.`);
    else if (value.length > spec.max) errors.push(`${spec.label} must be at most ${spec.max} characters.`);
    else intake[key] = value;
  }

  if (intake.website) {
    try {
      intake.website = normalizeWebsite(intake.website);
    } catch {
      errors.push("Website is not a valid URL.");
    }
  }

  return errors.length ? { errors } : { intake };
}

export function formatIntake(intake) {
  return Object.entries(FIELDS)
    .map(([key, spec]) => `- ${spec.label}: ${intake[key]}`)
    .join("\n");
}
