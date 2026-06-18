import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_COMPANIES } from '@/lib/companies-list';

// GET handler returns the default list of 1000 Indian IT companies
export async function GET() {
  try {
    return NextResponse.json({
      companies: DEFAULT_COMPANIES,
      count: DEFAULT_COMPANIES.length
    });
  } catch (error) {
    console.error('API Error in GET /api/companies:', error);
    return NextResponse.json(
      { error: 'Failed to retrieve company list.' },
      { status: 500 }
    );
  }
}

function extractCompanyFromObject(item: unknown): { name: string; website?: string; careers?: string } | null {
  if (!item || typeof item !== 'object') return null;

  // Cast to Record<string, unknown> to access properties by string keys
  const typedItem = item as Record<string, unknown>;

  const name = typedItem.name || typedItem.company || typedItem.companyName || typedItem.company_name || '';
  if (typeof name !== 'string' || !name.trim()) return null;

  const rawWebsite = typedItem.website || typedItem.website_url || typedItem.url || typedItem.homepage || typedItem.domain || '';
  let website = typeof rawWebsite === 'string' ? rawWebsite : '';

  const rawCareers = typedItem.careers || typedItem.careers_url || typedItem.career || typedItem.career_url || typedItem.jobs || typedItem.jobs_url || '';
  let careers = typeof rawCareers === 'string' ? rawCareers : '';

  // In user's JSON, website_url might contain the careers link (e.g. https://juspay.io/careers)
  // If only one URL is provided and it has career/job keywords, map it to careers instead of website
  if (website && !careers) {
    const lowerWeb = website.toLowerCase();
    if (lowerWeb.includes('career') || lowerWeb.includes('job') || lowerWeb.includes('work') || lowerWeb.includes('hiring') || lowerWeb.includes('join')) {
      careers = website;
      website = '';
    }
  }

  return {
    name: name.trim(),
    website: website.trim() || undefined,
    careers: careers.trim() || undefined
  };
}

// POST handler parses a uploaded raw text or JSON file of companies
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text } = body;

    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'Text content is required' }, { status: 400 });
    }

    let parsedCompanies: { name: string; website?: string; careers?: string }[] = [];
    const trimmedText = text.trim();

    const isJsonLike = trimmedText.startsWith('[') || 
                       trimmedText.startsWith('{') || 
                       (trimmedText.includes('{') && trimmedText.includes('}') && trimmedText.includes('"'));

    if (isJsonLike) {
      try {
        const parsed = JSON.parse(trimmedText);
        if (Array.isArray(parsed)) {
          parsedCompanies = parsed
            .map((item: unknown) => {
              if (typeof item === 'string') {
                return { name: item.trim() };
              } else {
                return extractCompanyFromObject(item);
              }
            })
            .filter((item): item is { name: string; website?: string; careers?: string } => !!item && item.name.length > 0);
        } else if (parsed && typeof parsed === 'object') {
          const list = parsed.companies || parsed.list || parsed.data || [];
          if (Array.isArray(list)) {
            parsedCompanies = list
              .map((item: unknown) => {
                if (typeof item === 'string') {
                  return { name: item.trim() };
                } else {
                  return extractCompanyFromObject(item);
                }
              })
              .filter((item): item is { name: string; website?: string; careers?: string } => !!item && item.name.length > 0);
          } else {
            const extracted = extractCompanyFromObject(parsed);
            if (extracted) {
              parsedCompanies = [extracted];
            }
          }
        }
      } catch (jsonErr: unknown) {
        // Fallback to regex extraction if JSON parsing fails but it is JSON-like text
        console.warn('Uploaded text was JSON-like but parsing failed, attempting regex block extraction:', (jsonErr as Error).message);
        
        // Match block-by-block contents between curly braces to capture company details
        const objectBlockRegex = /\{([^{}]+)\}/g;
        let blockMatch;
        while ((blockMatch = objectBlockRegex.exec(trimmedText)) !== null) {
          const blockContent = blockMatch[1];
          const nameMatch = /"(name|company|companyName|company_name)"\s*:\s*"([^"]+)"/.exec(blockContent);
          const webMatch = /"(website|website_url|url|homepage|domain)"\s*:\s*"([^"]+)"/.exec(blockContent);
          const careersMatch = /"(careers|careers_url|career|career_url|jobs|jobs_url)"\s*:\s*"([^"]+)"/.exec(blockContent);

          if (nameMatch) {
            const name = nameMatch[2].trim();
            if (name) {
              let website = webMatch ? webMatch[2].trim() : undefined;
              let careers = careersMatch ? careersMatch[2].trim() : undefined;

              // Normalize URLs
              if (website && !careers) {
                const lowerWeb = website.toLowerCase();
                if (lowerWeb.includes('career') || lowerWeb.includes('job') || lowerWeb.includes('work') || lowerWeb.includes('hiring') || lowerWeb.includes('join')) {
                  careers = website;
                  website = undefined;
                }
              }

              parsedCompanies.push({
                name,
                website,
                careers
              });
            }
          }
        }

        // If block extraction failed to retrieve anything, do a simple name match search fallback
        if (parsedCompanies.length === 0) {
          const nameRegex = /"(name|company|companyName|company_name)"\s*:\s*"([^"]+)"/g;
          let match;
          while ((match = nameRegex.exec(trimmedText)) !== null) {
            const extractedName = match[2].trim();
            if (extractedName) {
              parsedCompanies.push({ name: extractedName });
            }
          }
        }
      }
    }

    // Fallback to plain text line-by-line split if not JSON-like, or if regex extraction yielded nothing
    if (parsedCompanies.length === 0) {
      parsedCompanies = text
        .split('\n')
        .map(line => ({ name: line.trim() }))
        .filter(item => item.name.length > 0);
    }

    // Clean and deduplicate to avoid React duplicate key warnings in rendering
    const seenNames = new Set<string>();
    const uniqueCompanies = parsedCompanies.filter(item => {
      const trimmedName = item.name.trim();
      if (!trimmedName || seenNames.has(trimmedName)) {
        return false;
      }
      seenNames.add(trimmedName);
      return true;
    });

    return NextResponse.json({
      companies: uniqueCompanies,
      count: uniqueCompanies.length
    });
  } catch (error) {
    console.error('API Error in POST /api/companies:', error);
    return NextResponse.json(
      { error: 'Failed to parse uploaded companies.' },
      { status: 500 }
    );
  }
}
