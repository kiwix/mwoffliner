import MediaWiki from '../src/MediaWiki';
import Downloader from '../src/Downloader';
import { Dump } from '../src/Dump';

export function leftPad(_num: number, length: number) {
    const num = `${_num}`;
    return '0'.repeat(length - num.length) + num;
}

export function makeLink($doc: Document, href: string, rel: string, title: string, text: string = href, attributes: KVS<string> = {}) {
    const $link = $doc.createElement('a');
    $link.setAttribute('href', href);
    $link.setAttribute('rel', rel);
    $link.setAttribute('title', title);
    $link.innerHTML = text;

    for (const [key, value] of Object.entries(attributes)) {
        $link.setAttribute(key, value);
    }

    const $wrapper = $doc.createElement('div');
    $wrapper.appendChild($link);
    $doc.body.appendChild($wrapper);

    return $link;
}

export async function setupScrapeClasses({ mwUrl = 'https://en.wikipedia.org', format = '' } = {}) {
    const mw = new MediaWiki({
        base: mwUrl,
    } as any);

    const downloader = new Downloader({ mw, uaString: '', speed: 1, reqTimeout: 1000 * 60, useCache: false, cacheDirectory: `cac/dumps-${Date.now()}/`, noLocalParserFallback: false });

    await downloader.checkCapabilities();

    const mwMetadata = await mw.getMwMetaData(downloader);

    const dump = new Dump(format, {} as any, mwMetadata);

    return {
        mw,
        downloader,
        dump,
    };
}

export function sleep(ms: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
