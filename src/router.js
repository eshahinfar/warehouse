'use strict';
/* ======================================================================
   روتر بسیار سبک — تطبیق مسیر با پارامتر (مثل /api/products/:id) بدون
   نیاز به Express.
   ====================================================================== */

class Router {
  constructor() {
    this.routes = []; // { method, pattern: RegExp, paramNames: [], handler }
  }

  _register(method, path, handler) {
    const paramNames = [];
    const patternStr = path
      .split('/')
      .map(seg => {
        if (seg.startsWith(':')) {
          paramNames.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    const pattern = new RegExp(`^${patternStr}/?$`);
    this.routes.push({ method, pattern, paramNames, handler });
  }

  get(path, handler) { this._register('GET', path, handler); }
  post(path, handler) { this._register('POST', path, handler); }
  put(path, handler) { this._register('PUT', path, handler); }
  delete(path, handler) { this._register('DELETE', path, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      const params = {};
      route.paramNames.forEach((name, idx) => { params[name] = decodeURIComponent(m[idx + 1]); });
      return { handler: route.handler, params };
    }
    return null;
  }
}

module.exports = { Router };
