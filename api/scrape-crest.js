const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE = 'https://www.crestindustries.com';

function fetchUrl(urlStr, options = {}, cookieJar = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const cookies = Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; ');
    const reqOptions = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(cookies ? { 'Cookie': cookies } : {}),
        ...(options.headers || {}),
      },
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
        return fetchUrl(next, { method: 'GET' }, cookieJar).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: data, url: urlStr, cookieJar }));
    });
    req.on('error', reject);
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
  // Pattern: <li class="item product product-item"><a title="NAME" href="URL">
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
  // Fallback: product-item-link
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

// Recursively scrape a URL — goes up to maxDepth levels deep
async function scrapeDeep(url, name, cookieJar, seen, maxDepth, currentDepth = 0) {
  if (seen.has(url) || currentDepth > maxDepth) return [];
  seen.add(url);

  let page;
  try {
    page = await fetchUrl(url, {}, cookieJar);
  } catch(e) {
    return [];
  }

  const links = extractProductLinks(page.text);

  if (links.length === 0) {
    // This is a leaf product page — save it
    const skuM = url.match(/\/([A-Z0-9][A-Z0-9\-]{2,})\.html$/i);
    return [{
      part_number: skuM ? skuM[1] : name.slice(0, 50),
      description: name,
      category: mapCategory(name),
      oem_numbers: '',
      notes: '',
      source: 'Crest Industries',
    }];
  }

  // Has sub-links — recurse into each
  const products = [];
  for (const link of links) {
    if (seen.has(link.url)) continue;
    const sub = await scrapeDeep(link.url, link.name, cookieJar, seen, maxDepth, currentDepth + 1);
    products.push(...sub);
    // Safety: stop if we've collected enough for one batch
    if (products.length >= 150) break;
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

      // Get the top-level links for this category
      const catPage = await fetchUrl(categoryUrl, {}, cookieJar);
      const topLinks = extractProductLinks(catPage.text);

      if (topLinks.length === 0) {
        return res.json({ products: [], done: true, nextOffset: 0 });
      }

      // Process a batch of top-level links starting at offset
      const batchSize = 3; // process 3 top-level links per call to stay under timeout
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
