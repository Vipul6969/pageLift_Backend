const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");
const Together = require("together-ai").default;

// 🔥 Bypass SSL validation globally (for rare stubborn cases)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// Initialize Together client
const client = new Together({
  apiKey: "ae4e530d1b33a6b8a2e49de9adcafeeac1a29b1b1429bd6150e9f933989dd453",
});

// SerpAPI Key (you can also load from .env)
const SERP_API_KEY = "224791e1f04dc6ed46ce6ceb3dc3db718a99810ae218d34bfc41235f5422ba75";

// 📌 Function to get meta tags from a URL
async function crawlMetaTags(url) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  const response = await axios.get(url, { httpsAgent: agent });
  const $ = cheerio.load(response.data);

  return {
    title: $("title").text(),
    description: $('meta[name="description"]').attr("content") || "",
    canonical: $('link[rel="canonical"]').attr("href") || "",
    ogTitle: $('meta[property="og:title"]').attr("content") || "",
    ogDescription: $('meta[property="og:description"]').attr("content") || "",
  };
}

// 🔍 Fetch top competitor URLs using SerpAPI
async function getTopCompetitorUrls(query, count = 5) {
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(
    query
  )}&api_key=${SERP_API_KEY}&engine=google`;

  const res = await axios.get(url);
  const organicResults = res.data.organic_results || [];

  return organicResults.slice(0, count).map((result) => result.link);
}

// 🤖 AI function to generate SEO suggestions
async function generateSeoSuggestions(userMeta, competitorMeta) {
  const prompt = `
You are an SEO expert. Compare the following meta tags of the user's site vs competitor.

User's Meta:
Title: ${userMeta.title}
Description: ${userMeta.description}
Canonical: ${userMeta.canonical}
OG Title: ${userMeta.ogTitle}

Competitor's Meta:
Title: ${competitorMeta.title}
Description: ${competitorMeta.description}

Suggest improved SEO meta tags for the user's site based on this comparison. Return in JSON format with keys: title, description.
`;

  const stream = await client.chat.completions.create({
    model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
    messages: [{ role: "user", content: prompt }],
    stream: true,
  });

  let fullMessage = "";

  for await (const chunk of stream) {
    fullMessage += chunk.choices[0]?.delta?.content || "";
  }

  try {
    return JSON.parse(fullMessage);
  } catch (e) {
    return { suggestion: fullMessage.trim() };
  }
}

// 🌐 Main API handler
module.exports = async function (context, req) {
  const url = req.query.url || req.body?.url;

  if (!url || !url.startsWith("http")) {
    context.res = { status: 400, body: "Invalid or missing URL." };
    return;
  }

  try {
    const userMeta = await crawlMetaTags(url);

    const allLinks = [];
    const agent = new https.Agent({ rejectUnauthorized: false });
    const response = await axios.get(url, { httpsAgent: agent });
    const $ = cheerio.load(response.data);

    $("a").each((_, el) => {
      const href = $(el).attr("href");
      if (href && !href.startsWith("#")) {
        const fullUrl = href.startsWith("http")
          ? href
          : new URL(href, url).href;
        if (!allLinks.includes(fullUrl)) allLinks.push(fullUrl);
      }
    });

    // Get top competitor URLs using keyword from user title
    const competitors = await getTopCompetitorUrls(userMeta.title);
    const competitorUrl = competitors[0] || "";

    let competitorMeta = {
      title: "N/A",
      description: "N/A",
    };

    if (competitorUrl) {
      try {
        competitorMeta = await crawlMetaTags(competitorUrl);
      } catch (err) {
        console.warn("Failed to crawl competitor:", competitorUrl);
      }
    }

    const suggestions = await generateSeoSuggestions(userMeta, competitorMeta);

    context.res = {
      status: 200,
      body: {
        url,
        metaTags: userMeta,
        topCompetitor: competitorUrl,
        competitorMeta,
        links: allLinks.slice(0, 20),
        aiSuggestions: suggestions,
      },
    };
  } catch (err) {
    console.error("Error:", err.message);
    context.res = {
      status: 500,
      body: "Failed to crawl website or generate suggestions.",
    };
  }
};
