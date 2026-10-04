// The information we collect about a business before researching it.
// Required fields are the minimum needed to find the business online and
// identify its local competitors; everything else sharpens the report.

export const AI_EMPLOYEES = {
  social_media: "Social Media Manager",
  blog_content: "Blog & Content Writer",
  seo: "SEO Specialist",
  hr: "HR Coordinator",
  data_analyst: "Data Analyst",
  customer_support: "Customer Support Agent",
  sales: "Sales & Lead Follow-up Agent",
  email_marketing: "Email Marketing Agent",
  reputation: "Reviews & Reputation Manager",
};

const FIELDS = {
  // Required: identity and location
  businessName: { label: "Business name", required: true, max: 200 },
  website: { label: "Website", required: true, max: 500 },
  category: { label: "Business category", required: true, max: 200 },
  address: { label: "Street address", required: false, max: 300 },
  city: { label: "City", required: true, max: 120 },
  state: { label: "State / province", required: false, max: 120 },
  postalCode: { label: "Postal code", required: false, max: 20 },
  country: { label: "Country", required: true, max: 120 },

  // Optional: contact and presence
  phone: { label: "Phone", required: false, max: 50 },
  email: { label: "Business email", required: false, max: 200 },
  socialLinks: { label: "Social media profiles", required: false, max: 2000 },
  googleBusinessUrl: { label: "Google Business / Maps listing", required: false, max: 500 },

  // Optional: business context
  description: { label: "What the business does", required: false, max: 3000 },
  productsServices: { label: "Main products or services", required: false, max: 2000 },
  targetCustomers: { label: "Target customers", required: false, max: 2000 },
  serviceArea: { label: "Service area", required: false, max: 500 },
  knownCompetitors: { label: "Known competitors", required: false, max: 2000 },
  yearsInBusiness: { label: "Years in business", required: false, max: 50 },
  teamSize: { label: "Team size", required: false, max: 50 },
  revenueRange: { label: "Annual revenue range", required: false, max: 100 },
  goals: { label: "Top goals for the next 12 months", required: false, max: 3000 },
  challenges: { label: "Biggest challenges right now", required: false, max: 3000 },
  brandVoice: { label: "Brand voice / tone", required: false, max: 1000 },
  toolsUsed: { label: "Tools and systems already in use", required: false, max: 2000 },
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
    if (!value) {
      if (spec.required) errors.push(`${spec.label} is required.`);
      continue;
    }
    if (value.length > spec.max) {
      errors.push(`${spec.label} must be at most ${spec.max} characters.`);
      continue;
    }
    intake[key] = value;
  }

  if (intake.website) {
    try {
      intake.website = normalizeWebsite(intake.website);
    } catch {
      errors.push("Website is not a valid URL.");
    }
  }

  const requested = Array.isArray(body?.aiEmployees) ? body.aiEmployees : [];
  intake.aiEmployees = requested.filter((id) => id in AI_EMPLOYEES);
  if (intake.aiEmployees.length === 0) intake.aiEmployees = Object.keys(AI_EMPLOYEES);

  return errors.length ? { errors } : { intake };
}

// Renders the intake as a readable block for the prompts.
export function formatIntake(intake) {
  const lines = [];
  for (const [key, spec] of Object.entries(FIELDS)) {
    if (intake[key]) lines.push(`- ${spec.label}: ${intake[key]}`);
  }
  lines.push(`- AI employees to plan for: ${intake.aiEmployees.map((id) => AI_EMPLOYEES[id]).join(", ")}`);
  return lines.join("\n");
}
