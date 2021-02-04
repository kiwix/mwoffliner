import crypto from 'crypto';
import domino from 'domino';
import unicodeCutter from 'utf8-binary-cutter';
import countryLanguage from 'country-language';
import fs from 'fs';
import path from 'path';
import mkdirp from 'mkdirp';
import pathParser from 'path';
import { ZimCreator, ZimArticle } from '@openzim/libzim';
import { Config, config } from '../config';
import logger from '../Logger';
import { LATEX_GRAPHOID_IMAGE_URL_REGEX, WIKIHIERO_IMAGE_URL_REGEX, IMAGE_THUMB_URL_REGEX, FIND_HTTP_REGEX, IMAGE_URL_REGEX, BITMAP_IMAGE_MIME_REGEX, IMAGE_MIME_REGEX,
   WEBP_CANDIDATE_IMAGE_URL_REGEX, WEBP_CANDIDATE_IMAGE_MIME_TYPE } from './const';

export function isValidEmail(email: string) {
  const emailRegex = /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return emailRegex.test(email);
}

export function lcFirst(str: string) {
  str += '';
  const f = str.charAt(0).toLowerCase();
  return f + str.substr(1);
}

export function ucFirst(str: string) {
  str += '';
  const f = str.charAt(0).toUpperCase();
  return f + str.substr(1);
}

function _decodeURIComponent(uri: string) {
  try {
    return decodeURIComponent(uri);
  } catch (error) {
    logger.warn(error);
    return uri;
  }
}
export { _decodeURIComponent as decodeURIComponent };

export function touch(paths: string[] | string) {
  const currentDate = Date.now();
  paths = paths instanceof Array ? paths : [paths];
  paths.forEach((path) => {
    fs.utimes(path, currentDate, currentDate, () => null);
  });
}

export function getFullUrl(url: string, baseUrl: URL | string) {
  return new URL(url, baseUrl).toString();
}

export function getSizeFromUrl(url: string) {
  let mult;
  let width;
  const widthMatch = url.match(/[\/-]([0-9]+)px-/);
  if (widthMatch) {
    width = Number(widthMatch[1]);
  } else {
    const multMatch = url.match(/-([0-9.]+)x\./);
    if (multMatch) {
      mult = Number(multMatch[1]);
    }
  }
  return { mult, width };
}

export function randomString(len: number) {
  let str = '';
  const charSet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < len; i += 1) {
    const randomPoz = Math.floor(Math.random() * charSet.length);
    str += charSet.substring(randomPoz, randomPoz + 1);
  }
  return str;
}

export function mkdirPromise(path: string) {
  try {
    return mkdirp(path, { recursive: true })
  } catch(err){
    return err;
  }
}

export function writeFilePromise(path: string, content: string | Buffer, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    fs.writeFile(path, content, encoding, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function readFilePromise(path: string, encoding = 'utf8') {
  return new Promise<string | Buffer>((resolve, reject) => {
    fs.readFile(path, encoding, (err, content) => {
      if (err) {
        reject(err);
      } else {
        resolve(content);
      }
    });
  });
}

export function contains(arr: any[], value: any) {
  return arr.some((v) => v === value);
}

/*
 * Move 'from'.childNodes to 'to' adding them before 'beforeNode'
 * If 'beforeNode' is null, the nodes are appended at the end.
 */
export function migrateChildren(from: any, to: any, beforeNode: any) {
  if (beforeNode === undefined) {
    beforeNode = null;
  }
  while (from.firstChild) {
    to.insertBefore(from.firstChild, beforeNode);
  }
}

export function getStringsForLang(language: string, fallbackLanguage = 'en') {
  let strings: { [id: string]: string } = {};
  try {
    strings = require(`../../translation/${language}.json`);
  } catch (err) {
    logger.warn(`Couldn't find strings file for [${language}], falling back to [${fallbackLanguage}]`);
    strings = require(`../../translation/${fallbackLanguage}.json`);
  }
  return strings;
}

export function interpolateTranslationString(str: string, parameters: { [key: string]: string }) {
  let newString = str;
  for (const key of Object.keys(parameters)) {
    newString = newString.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), parameters[key]);
  }
  return newString;
}

export function saveStaticFiles(config: Config, zimCreator: ZimCreator) {
  const cssPromises = config.output.cssResources
    .concat(config.output.mainPageCssResources)
    .map(async (css) => {
      try {
        const cssCont = await readFilePromise(pathParser.resolve(__dirname, `../../res/${css}.css`));
        const article = new ZimArticle({ url: cssPath(css), data: cssCont, ns: '-' });
        zimCreator.addArticle(article);
      } catch (error) {
        logger.warn(`Could not create ${css} file : ${error}`);
      }
    });

  const jsPromises = config.output.jsResources.map(async (js) => {
    try {
      const jsCont = await readFilePromise(pathParser.resolve(__dirname, `../../res/${js}.js`));
      const article = new ZimArticle({ url: jsPath(js), data: jsCont, ns: '-' });
      zimCreator.addArticle(article);
    } catch (error) {
      logger.warn(`Could not create ${js} file : ${error}`);
    }
  });
  return Promise.all([
    ...cssPromises,
    ...jsPromises,
  ]);
}

export function cssPath(css: string, subDirectory: string = '') {
  return `${subDirectory ? `${subDirectory}/` : ''}${css.replace(/(\.css)?$/, '')}.css`;
}
export function jsPath(js: string, subDirectory: string = '') {
  const path = (isNodeModule(js)) ? normalizeModule(js) : js;
  return `${subDirectory ? `${config.output.dirs.mediawiki}/` : ''}${path.replace(/(\.js)?$/, '')}.js`;
}
export function genHeaderCSSLink(config: Config, css: string, articleId: string, subDirectory: string = '') {
  const resourceNamespace = '-';
  const slashesInUrl = articleId.split('/').length - 1;
  const upStr = '../'.repeat(slashesInUrl + 1);
  return `<link href="${upStr}${resourceNamespace}/${cssPath(css, subDirectory)}" rel="stylesheet" type="text/css"/>`;
}
export function genHeaderScript(config: Config, js: string, articleId: string, subDirectory: string = '') {
  const resourceNamespace = '-';
  const slashesInUrl = articleId.split('/').length - 1;
  const upStr = '../'.repeat(slashesInUrl + 1);
  const path = (isNodeModule(js)) ? normalizeModule(js) : js;
  return `<script src="${upStr}${resourceNamespace}/${jsPath(path, subDirectory)}"></script>`;
}
export function genCanonicalLink(config: Config, webUrl: string, articleId: string) {
  return `<link rel="canonical" href="${webUrl}${encodeURIComponent(articleId)}" />`;
}

export function getDumps(format: boolean | boolean[]) {
  let dumps: any[];
  if (format) {
    if (format instanceof Array) {
      dumps = [];
      const self =
        format.forEach((value) => {
          dumps.push(value === true ? '' : value);
        });
    } else if (format !== true) {
      dumps = [format];
    }
  } else {
    dumps = [''];
  }
  return dumps;
}

export function getIso3(langIso2: string): Promise<string> {
  return new Promise((resolve, reject) => {
    countryLanguage.getLanguage(langIso2, (error: any, language: KVS<any>) => {
      if (error || !language.iso639_3) {
        reject(error);
      } else {
        resolve(language.iso639_3 as string);
      }
    });
  });
}

/* Internal path/url functions */
export function getMediaBase(url: string, escape: boolean) {
  const decodedUrl = decodeURI(url);
  let parts;
  let filename;

  // Image thumbs
  if ((parts = IMAGE_THUMB_URL_REGEX.exec(decodedUrl)) !== null) {
      filename = parts[1].length > parts[3].length ? parts[1] : parts[3];
  }

  // Latex (equations) & Graphoid
  else if ((parts = LATEX_GRAPHOID_IMAGE_URL_REGEX.exec(decodedUrl)) !== null) {
      filename = parts[1] + '.svg';
  }

  // WikiHiero hieroglyphs (betting there won't be a name conflict with main namespace pictures)
  else if ((parts = WIKIHIERO_IMAGE_URL_REGEX.exec(decodedUrl)) !== null) {
      filename = parts[1];
  }

  // Default behaviour (make a hash of the URL)
  else {
      filename = crypto.createHash('md5').update(decodedUrl).digest('hex') + path.extname((new URL(url)).pathname);
  }

  return escape ? encodeURIComponent(filename) : filename;
}

export function getStrippedTitleFromHtml(html: string) {
  const doc = domino.createDocument(html);
  const titleEl = doc.querySelector('title');
  if (titleEl) {
    return titleEl.textContent;
  } else {
    return '';
  }
}

export function zip(...args: any[][]) {
  const len = Math.max(...args.map((arr) => arr.length));
  return ','.repeat(len).split(',')
    .map((_, i) => {
      return args.map((arr) => arr[i]);
    });
}

export function deDup<T>(_arr: T[], getter: (o: T) => any) {
  const arr = _arr.sort((a, b) => getter(a) < getter(b) ? -1 : 1);
  return arr.filter((item, index, arr) => {
    if (index + 1 === arr.length) {
      return true;
    }
    return getter(item) !== getter(arr[index + 1]);
  });
}

export function getRelativeFilePath(parentArticleId: string, fileBase: string, resourceNamespace: 'I' | 'A' | 'M' | '-') {
  const slashesInUrl = parentArticleId.split('/').length - 1;
  const upStr = '../'.repeat(slashesInUrl + 1);
  const newUrl = `${upStr}${resourceNamespace}/` + fileBase;
  return newUrl;
}

export function normalizeModule(path: string) {
  return path.replace('../node_modules', 'node_module');
}

export function isNodeModule(path: string) {
  return path.startsWith('../node_module');
}

export function objToQueryString(obj: KVS<any>): string {
  const str = [];
  for (const p in obj) {
    if (obj.hasOwnProperty(p) && typeof obj[p] !== 'undefined') {
      str.push(encodeURIComponent(p) + '=' + encodeURIComponent(obj[p]));
    }
  }
  return str.join('&');
}

export function sanitizeString(str: string) {
  return str.replace(/[&<>"'*=//]/g, ' ');
}

// We will need the encoded URL on article load so that we can set the hrefs of anchor tag correctly,
// but we must not encode the '/' character or else relative links may fail
export function encodeArticleIdForZimHtmlUrl(articleId: string) {
  return articleId && encodeURIComponent(articleId).replace(/%2F/g, '/');
}

export function ensureTrailingChar(input: string, trailingChar: string) {
  const pattern = `([^\\${trailingChar}])$`;
  const rx = new RegExp(pattern);
  return input.replace(rx, '$1' + trailingChar);
}

export function stripHttpFromUrl(url: string): string {
  return url.replace(FIND_HTTP_REGEX, '');
}


export function isImageUrl(url: string): boolean {
  return IMAGE_URL_REGEX.test(url);
}

export function isWebpCandidateImageUrl(url: string): boolean {
  return WEBP_CANDIDATE_IMAGE_URL_REGEX.test(url);
}

export function isImageMimeType(mimeType: string): boolean {
  return IMAGE_MIME_REGEX.test(mimeType);
}

export function isBitmapImageMimeType(mimeType: string): boolean {
  return BITMAP_IMAGE_MIME_REGEX.test(mimeType);
}

export function isWebpCandidateImageMimeType(webp: boolean, content_type: string) {
  return webp && WEBP_CANDIDATE_IMAGE_MIME_TYPE.test(content_type);
}