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

// Extract product-item links from a page (works for both category and subcategory pages)
function extractLinks(html) {
  const links = [];
  const seen = new Set();
  // Pattern 1: <li class="item product product-item"><a title="NAME" href="URL">
  const re1 = /<li[^>]+class="[^"]*product-item[^"]*"[^>]*>\s*<a[^>]+title="([^"]+)"[^>]+href="([^"]+)"/gis;
  let m;
  while ((m = re1.exec(html)) !== null) {
    const name = m[1].trim();
    const url = m[2].trim();
    if (!seen.has(url) && url.startsWith('http')) {
      seen.add(url);
      links.push({ name, url });
    }
  }
  // Pattern 2: product-item-link class
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
  const re = /<a[^>]+href="(https:\/\/www\.crestindustries\.com\/[^"]+\.html)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    const name = m[2].trim();
    if (!seen.has(url) && name && !url.includes('login') && !url.includes('account') && name.length > 2) {
      seen.add(url);
      cats.push({ url, name });
    }
  }
  return cats;
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
    // Login
    const loginPage = await fetchUrl(`${BASE}/customer/account/login/`, {}, cookieJar);
    const formKey = extractFormKey(loginPage.text);
    const loginResp = await fetchUrl(
      `${BASE}/customer/account/loginPost/`,
      { method: 'POST', body: encodeForm({ form_key: formKey, 'login[username]': email, 'login[password]': password }) },
      cookieJar
    );
    if (loginResp.url.includes('account/login') || loginResp.text.includes('Invalid')) {
      return res.status(401).json({ error: 'Login failed — check your email and password' });
    }

    if (mode === 'categories') {
      const homePage = await fetchUrl(BASE, {}, cookieJar);
      const cats = getCategoryLinks(homePage.text);
      return res.json({ categories: cats });
    }

    // mode === 'scrape' — scrape category page, then follow sub-links to find products
    const { categoryUrl, categoryName } = req.body;
    if (!categoryUrl) return res.status(400).json({ error: 'categoryUrl required' });

    const catPage = await fetchUrl(categoryUrl, {}, cookieJar);
    const topLinks = extractLinks(catPage.text);

    const products = [];
    const seen = new Set();

    // If we found links, check if they lead to products or sub-categories
    for (const link of topLinks.slice(0, 8)) { // limit to 8 to avoid timeout
      if (seen.has(link.url)) continue;
      seen.add(link.url);

      try {
        const subPage = await fetchUrl(link.url, {}, cookieJar);
        const subLinks = extractLinks(subPage.text);

        if (subLinks.length > 0) {
          // These are actual products
          for (const p of subLinks) {
            if (!seen.has(p.url)) {
              seen.add(p.url);
              const skuM = p.url.match(/\/([A-Z0-9][A-Z0-9\-]+)\.html$/i);
              products.push({
                part_number: skuM ? skuM[1] : p.name.slice(0, 40),
                description: p.name,
                category: mapCategory(p.name + ' ' + categoryName),
                oem_numbers: '',
                notes: link.name, // parent brand/subcategory as note
                source: 'Crest Industries',
              });
            }
          }
        } else {
          // The link itself is a product
          const skuM = link.url.match(/\/([A-Z0-9][A-Z0-9\-]+)\.html$/i);
          products.push({
            part_number: skuM ? skuM[1] : link.name.slice(0, 40),
            description: link.name,
            category: mapCategory(link.name + ' ' + categoryName),
            oem_numbers: '',
            notes: categoryName,
            source: 'Crest Industries',
          });
        }
      } catch(e) {
        // skip failed sub-pages
      }
    }

    return res.json({ products, category: categoryName, count: products.length });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
