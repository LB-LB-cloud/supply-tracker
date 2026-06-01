const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE = 'https://www.crestindustries.com';
const DELAY_MS = 150; // polite delay between requests

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchUrl(urlStr, options = {}, cookieJar = {}, retries = 2) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const cookies = Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; ');
    const reqOptions = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(cookies ? { 'Cookie': cookies } : {}),
        ...(options.headers || {}),
      },
      timeout: 8000,
    };
    if (options.body) {
      reqOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
    }
    const req = lib.request(reqOptions, (res) => {
      const setCookie = res.headers['set-cookie'] || [];
      setCookie.forEach(c => {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        if (k && v) cookieJar[k.trim()] = v.trim();
      });
      const location = res.headers['location'];
      if ([301,302,303,307,308].includes(res.statusCode) && location) {
        const next = location.startsWith('http') ? location : BASE + location;
        return fetchUrl(next, { method: 'GET' }, cookieJar, retries).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: data, url: urlStr, cookieJar }));
    });
    req.on('error', async (err) => {
      if (retries > 0) {
        await sleep(500);
        fetchUrl(urlStr, options, cookieJar, retries - 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
    req.on('timeout', async () => {
      req.destroy();
      if (retries > 0) {
        await sleep(500);
        fetchUrl(urlStr, options, cookieJar, retries - 1).then(resolve).catch(reject);
      } else {
        reject(new Error('Request timed out: ' + urlStr));
      }
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function encodeForm(obj) {
  return Object.entries(obj).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

function extractFormKey(html) {
  const m = html.match(/name="form_key"\s+value="([^"]+)"/);
  return m ? m[1] : '';
}

function mapCategory(name) {
  const n = name.toUpperCase();
  if (/RETAINER|CLIP|FASTENER|BOLT|SCREW|\bNUT\b|RIVET|GROMMET|PUSH.TYPE|PLASTIC NUT/.test(n)) return 'Fasteners';
  if (/PAINT|COAT|PRIMER|CLEAR COAT|OIL|FLUID|GREASE|LUBRIC|SOLVENT|CLEANER|WASH|SEAM SEAL|EPOXY|ABRASIVE|SANDPAPER|CUTTING/.test(n)) return 'Chemicals';
  if (/GLOVE|SAFETY|GOGGLE|EYEWEAR|SHIELD/.test(n)) return 'Safety';
  if (/\bTOOL\b|GUN|NOZZLE|APPLICAT|DRILL|BIT/.test(n)) return 'Tools';
  return 'Other';
}

function extractProductLinks(html) {
  const links = [];
  const seen = new Set();
  const re1 = /<li[^>]+class="[^"]*product-item[^"]*"[^>]*>\s*<a[^>]+title="([^"]+)"[^>]+href="([^"]+)"/gis;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const name = m[1].trim();
    const url = m[2].trim();
    if (!seen.has(url) && url.startsWith('http') && !url.includes('login') && !url.includes('account')) {
      seen.add(url);
      links.push({ name, url });
    }
  }
  const re2 = /<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  while ((m = re2.exec(html)) !== null) {
    const url = m[1].trim();
    const name = m[2].trim();
    if (!seen.has(url) && url.startsWith('http') && name) {
      seen.add(url);
      links.push({ name, url });
    }
  }
  return links;
}

function getCategoryLinks(html) {
  const cats = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https:\/\/www\.crestindustries\.com\/[^"#]+\.html)"[^>]*>([^<\n]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    const name = m[2].trim();
    if (!seen.has(url) && name && name.length > 2 &&
        !url.includes('login') && !url.includes('account') &&
        !url.includes('static') && !url.includes('media')) {
      seen.add(url);
      cats.push({ url, name });
    }
  }
  return cats;
}

// Extract full product details from a product detail page
function extractProductDetails(html, fallbackName, url) {
  // SKU
  let sku = '';
  const skuPatterns = [
    /["']sku["']\s*:\s*["']([^"']+)["']/i,
    /<div[^>]+class="[^"]*product-info-stock-sku[^"]*"[^>]*>[\s\S]*?<div[^>]+class="[^"]*value[^"]*"[^>]*>([^<]+)<\/div>/i,
    /\[itemprop="sku"\][^>]*>([^<]+)</i,
  ];
  for (const pat of skuPatterns) {
    const m = html.match(pat);
    if (m && m[1].trim()) { sku = m[1].trim(); break; }
  }
  if (!sku) {
    const urlM = url.match(/\/([A-Z0-9][A-Z0-9\-]{2,})\.html$/i);
    if (urlM) sku = urlM[1];
  }

  // Product name
  let name = fallbackName;
  const namePatterns = [
    /<h1[^>]*class="[^"]*page-title[^"]*"[^>]*>\s*<span[^>]*>([^<]+)<\/span>/i,
    /<h1[^>]*>\s*<span[^>]*>([^<]+)<\/span>/i,
    /<h1[^>]*>([^<]+)<\/h1>/i,
  ];
  for (const pat of namePatterns) {
    const m = html.match(pat);
    if (m && m[1].trim()) { name = m[1].trim(); break; }
  }

  // Price
  let price = '';
  const pricePatterns = [
    /["']finalPrice["'][\s\S]*?["']amount["']\s*:\s*([\d.]+)/i,
    /<span[^>]+class="[^"]*price[^"]*"[^>]*>\$?([\d,]+\.[\d]{2})<\/span>/i,
    /\[itemprop="price"\][^>]*content="([^"]+)"/i,
    /<meta[^>]+itemprop="price"[^>]+content="([^"]+)"/i,
  ];
  for (const pat of pricePatterns) {
    const m = html.match(pat);
    if (m && m[1].trim()) { price = m[1].replace(/,/g, '').trim(); break; }
  }

  // Image URL
  let image_url = '';
  const imgPatterns = [
    /"image"\s*:\s*"([^"]+)"/i,
    /<img[^>]+class="[^"]*gallery-placeholder__image[^"]*"[^>]+src="([^"]+)"/i,
    /<img[^>]+id="[^"]*landingImage[^"]*"[^>]+src="([^"]+)"/i,
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
  ];
  for (const pat of imgPatterns) {
    const m = html.match(pat);
    if (m && m[1].trim() && m[1].includes('http')) { image_url = m[1].trim(); break; }
  }

  // Description
  let description = '';
  const descPatterns = [
    /<div[^>]+class="[^"]*product attribute description[^"]*"[^>]*>[\s\S]*?<div[^>]+class="[^"]*value[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class="[^"]*product-info-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<meta[^>]+name="description"[^>]+content="([^"]+)"/i,
  ];
  for (const pat of descPatterns) {
    const m = html.match(pat);
    if (m && m[1].trim()) {
      description = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
      break;
    }
  }

  // Specs — extract from additional attributes table
  const specs = {};
  const attrRe = /<tr[^>]*>[\s\S]*?<th[^>]*>([^<]+)<\/th>[\s\S]*?<td[^>]*>([^<]+)<\/td>[\s\S]*?<\/tr>/gi;
  let attrM;
  while ((attrM = attrRe.exec(html)) !== null) {
    const key = attrM[1].replace(/<[^>]+>/g, '').trim();
    const val = attrM[2].replace(/<[^>]+>/g, '').trim();
    if (key && val && key.length < 60 && val.length < 200) {
      specs[key] = val;
    }
  }

  // OEM / cross-reference
  let oem_numbers = '';
  const oemKeys = ['oem', 'cross', 'interchange', 'replaces', 'fits', 'compatible'];
  for (const [k, v] of Object.entries(specs)) {
    if (oemKeys.some(w => k.toLowerCase().includes(w))) {
      oem_numbers = v;
      break;
    }
  }

  return {
    part_number: sku || name.slice(0, 50),
    description: name,
    long_description: description,
    category: mapCategory(name),
    price: price ? parseFloat(price) || null : null,
    image_url: image_url || null,
    specs: Object.keys(specs).length ? JSON.stringify(specs) : null,
    oem_numbers: oem_numbers,
    notes: '',
    source: 'Crest Industries',
  };
}

async function login(email, password, cookieJar) {
  const loginPage = await fetchUrl(`${BASE}/customer/account/login/`, {}, cookieJar);
  const formKey = extractFormKey(loginPage.text);
  const loginResp = await fetchUrl(
    `${BASE}/customer/account/loginPost/`,
    { method: 'POST', body: encodeForm({ form_key: formKey, 'login[username]': email, 'login[password]': password }) },
    cookieJar
  );
  return !loginResp.url.includes('account/login') && !loginResp.text.includes('Invalid');
}

async function scrapeDeep(url, name, cookieJar, seen, maxDepth, currentDepth = 0) {
  if (seen.has(url) || currentDepth > maxDepth) return [];
  seen.add(url);

  await sleep(DELAY_MS);

  let page;
  try {
    page = await fetchUrl(url, {}, cookieJar);
  } catch(e) {
    return [];
  }

  const links = extractProductLinks(page.text);

  if (links.length === 0) {
    // Leaf product page — extract full details
    const product = extractProductDetails(page.text, name, url);
    return [product];
  }

  // Has sub-links — recurse
  const products = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    const sub = await scrapeDeep(link.url, link.name, cookieJar, seen, maxDepth, currentDepth + 1);
    products.push(...sub);
    if (products.length >= 100) break;
  }
  return products;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, mode } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const cookieJar = {};

  try {
    const ok = await login(email, password, cookieJar);
    if (!ok) return res.status(401).json({ error: 'Login failed — check your email and password' });

    if (mode === 'categories') {
      const homePage = await fetchUrl(BASE, {}, cookieJar);
      const cats = getCategoryLinks(homePage.text);
      return res.json({ categories: cats });
    }

    if (mode === 'scrape') {
      const { categoryUrl, categoryName, offset = 0 } = req.body;
      if (!categoryUrl) return res.status(400).json({ error: 'categoryUrl required' });

      const catPage = await fetchUrl(categoryUrl, {}, cookieJar);
      const topLinks = extractProductLinks(catPage.text);

      if (topLinks.length === 0) {
        return res.json({ products: [], done: true, nextOffset: 0, totalLinks: 0, processedLinks: 0 });
      }

      const batchSize = 2; // smaller batch to allow delays + deeper scraping within timeout
      const batch = topLinks.slice(offset, offset + batchSize);
      const seen = new Set([categoryUrl]);
      const products = [];

      for (const link of batch) {
        const sub = await scrapeDeep(link.url, link.name, cookieJar, seen, 3);
        products.push(...sub);
      }

      const nextOffset = offset + batchSize;
      const done = nextOffset >= topLinks.length;

      return res.json({
        products,
        done,
        nextOffset,
        totalLinks: topLinks.length,
        processedLinks: Math.min(nextOffset, topLinks.length),
      });
    }

    return res.status(400).json({ error: 'Invalid mode' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
