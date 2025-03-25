const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const Together = require("together-ai").default;
// const { getJson } = require("serpapi");

// ========== CONFIG ========== //
const client = new Together({
  apiKey: "ae4e530d1b33a6b8a2e49de9adcafeeac1a29b1b1429bd6150e9f933989dd453",
});
const SERP_API_KEY =
  "224791e1f04dc6ed46ce6ceb3dc3db718a99810ae218d34bfc41235f5422ba75";

// ========== HANDLERS ========== //
async function crawlWebsite(url) {
  console.log(`Crawling ${url}`);
  try {
    const agent = new https.Agent({ rejectUnauthorized: false });

    const { data } = await axios.get(url, {
      httpsAgent: agent,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
    });

    const $ = cheerio.load(data);

    const ogTitle = $('meta[property="og:title"]').attr("content");
    const ogDescription = $('meta[property="og:description"]').attr("content");
    const title = $("title").text() || ogTitle || "";
    const description =
      $('meta[name="description"]').attr("content") || ogDescription || "";

    const links = $("a")
      .map((i, el) => $(el).attr("href"))
      .get()
      .filter(Boolean)
      .slice(0, 10);

    return { title, description, links };
  } catch (err) {
    return { error: `Error crawling ${url}: ${err.message}` };
  }
}

async function callTogetherAI(prompt) {
  const stream = await client.chat.completions.create({
    model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    messages: [{ role: "user", content: prompt }],
    stream: true,
  });

  let fullMessage = "";

  for await (const chunk of stream) {
    fullMessage += chunk.choices[0]?.delta?.content || "";
  }

  // Always return as a string suggestion
  try {
    const parsed = JSON.parse(fullMessage);
    console.log(parsed);
    return typeof parsed === "string" ? { suggestion: parsed } : parsed;
  } catch {
    return { suggestion: fullMessage.trim() };
  }
}

async function getPurpose(metadata) {
  const prompt = `Given this metadata, classify the website's **main industry or category** using a single word or phrase, such as "e-commerce", "news", "education", "travel", etc.
Then, list **four URLs of real-world websites** that serve a similar purpose or are competitors in that category.
Return only JSON with this format:

{
  "category": "<industry>",
  "competitors": ["https://...", "https://...", "https://...", "https://..."]
}

Here is the metadata:
${JSON.stringify(metadata, null, 2)}
`;

  const result = await callTogetherAI(prompt);

  // result is already parsed
  if (
    result &&
    Array.isArray(result.competitors) &&
    result.competitors.length >= 4
  ) {
    return result;
  } else {
    console.error("Failed to parse purpose result:", result);
    return { category: "unknown", competitors: [] };
  }
}

async function getSeoScore(metadata) {
  const prompt = `Based on this metadata, give an SEO score between 0 to 100 and explain why:\n\n${JSON.stringify(
    metadata
  )}\n\nFormat:\nScore: <number>\nExplanation: <text>`;
  const response = await callTogetherAI(prompt);

  const rawText =
    typeof response === "string"
      ? response
      : response?.suggestion || JSON.stringify(response);

  const match = rawText.match(/Score:\s*(\d{1,3})[\s\S]*?Explanation:\s*(.*)/i);

  if (match) {
    return {
      score: parseInt(match[1], 10),
      explanation: match[2].trim(),
    };
  }

  return { score: null, explanation: rawText.trim() };
}

async function getSuggestions(userMeta, competitorMetaList) {
  const prompt = `
You are an expert SEO consultant.

Compare the following user's website metadata with two competitors.
Give 3–5 **clear, actionable** suggestions that can **improve the user's SEO**, using competitor insights.
Only give suggestions that are helpful and realistic to implement.

User Website Metadata:
${JSON.stringify(userMeta, null, 2)}

Competitor 1 Metadata:
${JSON.stringify(competitorMetaList[0], null, 2)}

Competitor 2 Metadata:
${JSON.stringify(competitorMetaList[1], null, 2)}

Suggestions:
`;

  return await callTogetherAI(prompt);
}

// async function searchTopCompetitors(purpose) {
//   return new Promise((resolve, reject) => {
//     getJson(
//       {
//         engine: "google",
//         q: purpose,
//         api_key: SERP_API_KEY,
//       },
//       (json) => {
//         if (!json || !json.organic_results) {
//           return reject(new Error("No search results found"));
//         }

//         const urls = json.organic_results
//           .map((r) => r.link)
//           .filter((link) => link && link.startsWith("http"))
//           .slice(0, 2);

//         resolve(urls);
//       }
//     );
//   });
// }

// ========== MAIN AZURE FUNCTION ========== //
module.exports = async function (context, req) {
  const url = req.query.url || req.body?.url;

  if (!url || !url.startsWith("http")) {
    context.res = { status: 400, body: "Invalid or missing URL." };
    return;
  }

  try {
    console.log(`Processing ${url}`);
    // Step 1: Crawl user website
    const userMeta = await crawlWebsite(url);

    // Step 2: Get Purpose/Category
    // Step 2: Get Competitor URLs using AI (and purpose)
    const { category: purpose, competitors } = await getPurpose(userMeta);

    console.log("Competitor URLs:", competitors);

    if (!competitors || competitors.length < 2) {
      throw new Error("Failed to retrieve competitor URLs.");
    }

    console.log("Detected Purpose:", purpose);

    // Step 3: SEO Score for user
    const userScore = await getSeoScore(userMeta);

    // Step 4: Search competitors
    // const competitors = await searchTopCompetitors(purpose.toLowerCase());
    console.log("Competitor URLs:", competitors);

    // Step 5: Crawl competitors
    // Crawl each competitor site safely and skip those that fail
    const competitorData = [];

    for (const compUrl of competitors) {
      try {
        const meta = await crawlWebsite(compUrl);

        if (meta.error) {
          console.warn(`Skipping ${compUrl}: ${meta.error}`);
          continue;
        }

        const score = await getSeoScore(meta);
        competitorData.push({
          url: compUrl,
          metadata: meta,
          seoScore: score,
        });
      } catch (err) {
        console.warn(`Error crawling ${compUrl}:`, err.message);
        continue;
      }
    }

    // Ensure we have at least 2 valid competitor results
    if (competitorData.length < 2) {
      throw new Error("Failed to crawl at least 2 competitor websites.");
    }

    // Step 6: Get AI SEO Suggestions
    const suggestions = await getSuggestions(
      userMeta,
      competitorData.map((c) => c.metadata)
    );

    // Final Output
    context.res = {
      status: 200,
      body: {
        inputUrl: url,
        purpose,
        user: {
          metadata: userMeta,
          seoScore: userScore.score,
          explanation: userScore.explanation,
        },
        competitors: competitorData,
        suggestions,
      },
    };
  } catch (err) {
    console.error("Unexpected error:", err);
    context.res = {
      status: 500,
      body: { error: "Unexpected error", message: err.message },
    };
  }
};
