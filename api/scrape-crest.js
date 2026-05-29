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
  if (/PAINT|COAT|PRIMER|CLEAR COAT|OIL|FLUID|GREASE|LUBRIC|SOLVENT|CLEANER|WASH|SEAM SEAL|EPOXY/.test(n)) return 'Chemicals';
  if (/GLOVE|SAFETY|GOGGLE|EYEWEAR|SHIELD/.test(n)) return 'Safety';
  if (/\bTOOL\b|GUN|NOZZLE|APPLICAT/.test(n)) return 'Tools';
  return 'Other';
}

function extractProducts(html, categoryName) {
  const products = [];
  const seen = new Set();
  const linkRe = /<a[^>]+class="[^"]*product-item-link[^"]*"[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const url = m[1].trim();
    const name = m[2].trim();
    if (!seen.has(url) && name) {
      seen.add(url);
      const skuM = url.match(/\/([A-Z0-9\-]+)\.html$/i);
      const sku = skuM ? skuM[1] : name.slice(0, 40);
      products.push({ url, name, sku });
    }
  }
  if (products.length === 0) {
    const nameRe = /<strong[^>]+class="[^"]*product-item-name[^"]*"[^>]*>.*?<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gis;
    while ((m = nameRe.exec(html)) !== null) {
      const url = m[1].trim();
      const name = m[2].trim();
      if (!seen.has(url) && name) {
        seen.add(url);
        const skuM = url.match(/\/([A-Z0-9\-]+)\.html$/i);
        products.push({ url, name, sku: skuM ? skuM[1] : name.slice(0,40) });
      }
    }
  }
  return products.map(p => ({
    part_number: p.sku,
    description: p.name,
    category: mapCategory(p.name + ' ' + categoryName),
    oem_numbers: '',
    notes: '',
    source: 'Crest Industries',
  }));
}

function getCategoryLinks(html) {
  const cats = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https:\/\/www\.crestindustries\.com\/[^"]+\.html)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1].trim();
    const name = m[2].trim();
    if (!seen.has(url) && name && !url.includes('login') && !url.includes('account')) {
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

    const { categoryUrl, categoryName } = req.body;
    if (!categoryUrl) return res.status(400).json({ error: 'categoryUrl required' });

    const catPage = await fetchUrl(categoryUrl, {}, cookieJar);
    const products = extractProducts(catPage.text, categoryName || '');
    return res.json({ products, category: categoryName, count: products.length });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
