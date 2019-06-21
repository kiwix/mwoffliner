import logger from '../Logger';
import Downloader from '../Downloader';
import MediaWiki from '../MediaWiki';
import { ZimCreator, ZimArticle } from '@openzim/libzim';
import htmlMinifier from 'html-minifier';
import * as urlParser from 'url';

import DU from '../DOMUtils';
import * as domino from 'domino';
import { Dump } from '../Dump';
import { mapLimit } from 'promiso';
import { getFullUrl, genHeaderScript, genHeaderCSSLink, jsPath, contains, getMediaBase } from '.';
import { config } from '../config';
import { htmlTemplateCode, footerTemplate } from '../Templates';
import { filesToDownloadXPath, articleDetailXId, scrapeStatus, filesToRetryXPath } from '../stores';
import { getSizeFromUrl, getRelativeFilePath } from './misc';
import { RedisKvs } from './redis-kvs';
import { rewriteUrl } from './rewriteUrls';

const genericJsModules = config.output.mw.js;
const genericCssModules = config.output.mw.css;

type FileStore = RedisKvs<{
    url: string;
    namespace: string;
    mult?: number;
    width?: number;
}>;

export async function downloadFiles(fileStore: FileStore, zimCreator: ZimCreator, downloader: Downloader, isRetry = false) {
    const numKeys = await fileStore.len();
    logger.log(`${isRetry ? 'Retrying' : 'Downloading'} a total of [${numKeys}] files`);
    let prevPercentProgress = -1;

    await fileStore.iterateItems(downloader.speed, async (fileDownloadPairs, workerId) => {
        logger.log(`Worker [${workerId}] Processing batch of [${Object.keys(fileDownloadPairs).length}] files`);

        for (const [path, { url, namespace, mult, width }] of Object.entries(fileDownloadPairs)) {
            try {
                let content;
                const resp = await downloader.downloadContent(url);
                content = resp.content;

                const article = new ZimArticle({ url: path, data: content, ns: namespace });
                await zimCreator.addArticle(article);

                scrapeStatus.files.success += 1;
            } catch (err) {
                if (!isRetry) {
                    await filesToRetryXPath.set(path, { url, namespace, mult, width });
                } else {
                    logger.warn(`Error downloading file [${url}], skipping`);
                    scrapeStatus.files.fail += 1;
                    await filesToDownloadXPath.delete(path);
                }
            }

            if (scrapeStatus.files.success % 10 === 0) {
                const percentProgress = Math.floor(scrapeStatus.files.success / numKeys * 1000) / 10;
                if (percentProgress !== prevPercentProgress) {
                    prevPercentProgress = Math.min(percentProgress, 100);
                    logger.log(`Progress downloading files [${scrapeStatus.files.success}/${numKeys}] [${percentProgress}%]`);
                }
            }
        }
    });

    if (!isRetry) {
        await downloadFiles(filesToRetryXPath, zimCreator, downloader, true);
    }
}

export async function saveArticles(zimCreator: ZimCreator, downloader: Downloader, mw: MediaWiki, dump: Dump) {
    const jsModuleDependencies = new Set<string>();
    const cssModuleDependencies = new Set<string>();
    let jsConfigVars = '';
    let prevPercentProgress = -1;

    await articleDetailXId.iterateItems(
        downloader.speed,
        async (articleKeyValuePairs, workerId) => {
            const articleKeys = Object.keys(articleKeyValuePairs);
            logger.log(`Worker [${workerId}] Processing batch of article ids [${logger.logifyArray(articleKeys)}]`);
            const numKeys = await articleDetailXId.len();
            for (const [articleId, articleDetail] of Object.entries(articleKeyValuePairs)) {
                try {
                    const useParsoidFallback = articleId === dump.mwMetaData.mainPage;
                    const rets = await downloader.getArticle(articleId, dump, useParsoidFallback);

                    for (const { articleId, displayTitle, html } of rets) {
                        const nonPaginatedArticleId = articleDetail.title.replace(/ /g, '_');
                        const articleHtml = html;
                        const articleTitle = displayTitle;
                        if (!articleHtml) {
                            logger.warn(`No HTML returned for article [${articleId}], skipping`);
                            continue;
                        }

                        const { articleDoc, mediaDependencies } = await processArticleHtml(articleHtml, downloader, mw, dump, articleId);
                        for (const dep of mediaDependencies) {

                            const { mult, width } = getSizeFromUrl(dep.url);

                            const existingVal = await filesToDownloadXPath.get(dep.path);
                            const currentDepIsHigherRes = !existingVal || existingVal.width < width || existingVal.mult < mult;
                            if (currentDepIsHigherRes) {
                                await filesToDownloadXPath.set(dep.path, { url: dep.url, namespace: 'I', mult, width });
                            }
                        }

                        const _moduleDependencies = await getModuleDependencies(nonPaginatedArticleId, mw, downloader);

                        for (const dep of _moduleDependencies.jsDependenciesList) {
                            jsModuleDependencies.add(dep);
                        }
                        for (const dep of _moduleDependencies.styleDependenciesList) {
                            cssModuleDependencies.add(dep);
                        }

                        jsConfigVars = jsConfigVars || _moduleDependencies.jsConfigVars[0];

                        const outHtml = await templateArticle(articleDoc, _moduleDependencies, mw, dump, articleId, articleDetail);
                        const zimArticle = new ZimArticle({ url: articleId + (dump.nozim ? '.html' : ''), data: outHtml, ns: 'A', mimeType: 'text/html', title: articleTitle, shouldIndex: true });
                        await zimCreator.addArticle(zimArticle);

                        scrapeStatus.articles.success += 1;
                    }
                } catch (err) {
                    scrapeStatus.articles.fail += 1;
                    logger.warn(`Error downloading article [${articleId}], skipping`, err);
                    await articleDetailXId.delete(articleId);
                }

                if (scrapeStatus.articles.success % 10 === 0) {
                    const percentProgress = Math.floor(scrapeStatus.articles.success / numKeys * 1000) / 10;
                    if (percentProgress !== prevPercentProgress) {
                        prevPercentProgress = Math.min(percentProgress, 100);
                        logger.log(`Progress downloading articles [${scrapeStatus.articles.success}/${numKeys}] [${percentProgress}%]`);
                    }
                }
            }
        },
    );

    const jsConfigVarArticle = new ZimArticle({ url: jsPath(config, 'jsConfigVars'), data: jsConfigVars, ns: '-' });
    await zimCreator.addArticle(jsConfigVarArticle);

    return {
        jsModuleDependencies,
        cssModuleDependencies,
    };
}

async function getModuleDependencies(articleId: string, mw: MediaWiki, downloader: Downloader) {
    // these vars will store the list of js and css dependencies for the article we are downloading. they are populated in storeDependencies and used in setFooter
    let jsConfigVars: string | RegExpExecArray = '';
    let jsDependenciesList: string[] = [];
    let styleDependenciesList: string[] = [];

    const articleApiUrl = mw.articleApiUrl(articleId);

    const articleData = await downloader.getJSON<any>(articleApiUrl);
    const {
        parse: {
            modules, modulescripts, modulestyles, headhtml,
        },
    } = articleData;

    jsDependenciesList = genericJsModules.concat(modules, modulescripts).filter((a) => a);
    styleDependenciesList = [].concat(modules, modulestyles, genericCssModules).filter((a) => a);

    styleDependenciesList = styleDependenciesList.filter(
        (oneStyleDep) => !contains(config.filters.blackListCssModules, oneStyleDep),
    );

    logger.info(`Js dependencies of ${articleId} : ${jsDependenciesList}`);
    logger.info(`Css dependencies of ${articleId} : ${styleDependenciesList}`);

    // Saving, as a js module, the jsconfigvars that are set in the header of a wikipedia page
    // the script below extracts the config with a regex executed on the page header returned from the api
    const scriptTags = domino.createDocument(`${headhtml['*']}</body></html>`).getElementsByTagName('script');
    const regex = /mw\.config\.set\(\{.*?\}\);/mg;
    // tslint:disable-next-line:prefer-for-of
    for (let i = 0; i < scriptTags.length; i += 1) {
        if (scriptTags[i].text.includes('mw.config.set')) {
            jsConfigVars = regex.exec(scriptTags[i].text);
        }
    }

    jsConfigVars = `(window.RLQ=window.RLQ||[]).push(function() {${jsConfigVars}});`;
    jsConfigVars = jsConfigVars.replace('nosuchaction', 'view'); // to replace the wgAction config that is set to 'nosuchaction' from api but should be 'view'

    return {
        jsConfigVars,
        jsDependenciesList,
        styleDependenciesList,
    };
}

async function processArticleHtml(html: string, downloader: Downloader, mw: MediaWiki, dump: Dump, articleId: string) {
    let mediaDependencies: Array<{ url: string, path: string }> = [];

    let doc = domino.createDocument(html);
    const tmRet = await treatMedias(doc, mw, dump, articleId);
    doc = tmRet.doc;
    mediaDependencies = mediaDependencies.concat(
        tmRet.mediaDependencies
            .filter((a) => a)
            .map((url) => {
                const path = getMediaBase(url, false);
                return { url, path };
            }),
    );

    const ruRet = await rewriteUrls(doc, articleId, downloader, mw, dump);
    doc = ruRet.doc;
    mediaDependencies = mediaDependencies.concat(
        ruRet.mediaDependencies
            .filter((a) => a)
            .map((url) => {
                const path = getMediaBase(url, false);
                return { url, path };
            }),
    );
    doc = applyOtherTreatments(doc, dump);
    return {
        articleDoc: doc,
        mediaDependencies,
    };
}

function widthXHeightSorter(a: DominoElement, b: DominoElement) {
    // If there is no width/height, it counts as zero, probably best?
    // Sometimes (pure audio) there will only be one item
    // Sometimes (pure audio) there won't be width/height
    const aWidth = Number(a.getAttribute('data-file-width') || a.getAttribute('data-width') || 0);
    const aHeight = Number(a.getAttribute('data-file-height') || a.getAttribute('data-height') || 0);
    const bWidth = Number(b.getAttribute('data-file-width') || b.getAttribute('data-width') || 0);
    const bHeight = Number(b.getAttribute('data-file-height') || b.getAttribute('data-height') || 0);

    const aVal = aWidth * aHeight;
    const bVal = bWidth * bHeight;
    return aVal > bVal ? 1 : -1;
}

async function treatVideo(mw: MediaWiki, dump: Dump, srcCache: KVS<boolean>, articleId: string, videoEl: DominoElement): Promise<{ mediaDependencies: string[] }> {
    const webUrlHost = urlParser.parse(mw.webUrl).host;
    const mediaDependencies: string[] = [];
    // Worth noting:
    // Video tags are used for audio files too (as opposed to the audio tag)
    // When it's only audio, there will be a single OGG file
    // For video, we get multiple SOURCE tages with different resolutions

    const posterUrl = videoEl.getAttribute('poster');
    const videoPosterUrl = getFullUrl(webUrlHost, posterUrl);
    const newVideoPosterUrl = getRelativeFilePath(articleId, getMediaBase(videoPosterUrl, true), 'I');
    let videoSources: any[] = Array.from(videoEl.children).filter((child: any) => child.tagName === 'SOURCE');

    // Firefox is not able to display correctly <video> nodes with a height < 40.
    // In that case the controls are not displayed.
    if (videoEl.getAttribute('height') && videoEl.getAttribute('height') < 40) {
        videoEl.setAttribute('height', '40');
    }

    // Always show controls
    videoEl.setAttribute('controls', '40');

    if (dump.nopic || dump.novid || dump.nodet) {
        DU.deleteNode(videoEl);
        return { mediaDependencies };
    }

    if (posterUrl) { videoEl.setAttribute('poster', newVideoPosterUrl); }
    videoEl.removeAttribute('resource');

    if (!srcCache.hasOwnProperty(videoPosterUrl)) {
        srcCache[videoPosterUrl] = true;
        mediaDependencies.push(videoPosterUrl);
    }

    videoSources = videoSources.sort(widthXHeightSorter);

    const sourcesToRemove = videoSources.slice(1); // All but first

    sourcesToRemove.forEach(DU.deleteNode);

    const sourceEl = videoSources[0]; // Use first source (smallest resolution)

    const sourceUrl = getFullUrl(webUrlHost, sourceEl.getAttribute('src'));
    const fileBase = getMediaBase(sourceUrl, true);

    if (!fileBase) {
        DU.deleteNode(sourceEl);
        return;
    }

    const newUrl = getRelativeFilePath(articleId, fileBase, 'I');

    /* Download content, but avoid duplicate calls */
    if (!srcCache.hasOwnProperty(sourceUrl)) {
        srcCache[sourceUrl] = true;
        mediaDependencies.push(sourceUrl);
    }

    sourceEl.setAttribute('src', newUrl);
    return { mediaDependencies };
}

async function treatImage(mw: MediaWiki, dump: Dump, srcCache: KVS<boolean>, articleId: string, img: DominoElement): Promise<{ mediaDependencies: string[] }> {
    const webUrlHost = urlParser.parse(mw.webUrl).host;
    const mediaDependencies: string[] = [];

    const imageNodeClass = img.getAttribute('class') || '';

    if (
        (!dump.nopic
            || imageNodeClass.search('mwe-math-fallback-image-inline') >= 0
            || img.getAttribute('typeof') === 'mw:Extension/math')
        && img.getAttribute('src')
        && img.getAttribute('src').indexOf('./Special:FilePath/') !== 0
    ) {
        /* Remove image link */
        const linkNode = img.parentNode;
        if (linkNode.tagName === 'A') {
            /* Check if the target is mirrored */
            const href = linkNode.getAttribute('href') || '';
            const title = mw.extractPageTitleFromHref(href);
            const keepLink = title && await isMirrored(title);

            /* Under certain condition it seems that this is possible
                             * to have parentNode == undefined, in this case this
                             * seems preferable to remove the whole link+content than
                             * keeping a wrong link. See for example this url
                             * http://parsoid.wmflabs.org/ko/%EC%9D%B4%ED%9C%98%EC%86%8C */
            if (!keepLink) {
                if (linkNode.parentNode) {
                    linkNode.parentNode.replaceChild(img, linkNode);
                } else {
                    DU.deleteNode(img);
                }
            }
        }

        /* Rewrite image src attribute */
        if (img) {
            const src = getFullUrl(webUrlHost, img.getAttribute('src'));
            let newSrc: string;
            try {
                const resourceNamespace = 'I';
                const slashesInUrl = articleId.split('/').length - 1;
                const upStr = '../'.repeat(slashesInUrl + 1);
                newSrc = `${upStr}${resourceNamespace}/` + getMediaBase(src, true);
            } catch (err) { /* NOOP */ }

            if (newSrc) {
                /* Download image, but avoid duplicate calls */
                if (!srcCache.hasOwnProperty(src)) {
                    srcCache[src] = true;
                    mediaDependencies.push(src);
                }

                /* Change image source attribute to point to the local image */
                img.setAttribute('src', newSrc);

                /* Remove useless 'resource' attribute */
                img.removeAttribute('resource');

                /* Remove srcset */
                img.removeAttribute('srcset');
            } else {
                DU.deleteNode(img);
            }
        }
    } else {
        DU.deleteNode(img);
    }
    return { mediaDependencies };
}

function treatImageFrames(mw: MediaWiki, dump: Dump, parsoidDoc: DominoElement, imageNode: DominoElement) {
    let image;
    const numImages = imageNode.getElementsByTagName('img').length;
    const numVideos = imageNode.getElementsByTagName('video').length;
    if (numImages) {
        image = imageNode.getElementsByTagName('img')[0];
    } else if (numVideos) {
        image = imageNode.getElementsByTagName('video')[0];
    }
    const isStillLinked = image && image.parentNode && image.parentNode.tagName === 'A';

    if (!dump.nopic && imageNode && image) {
        const imageNodeClass = imageNode.getAttribute('class') || ''; // imageNodeClass already defined
        const imageNodeTypeof = imageNode.getAttribute('typeof') || '';

        const descriptions = imageNode.getElementsByTagName('figcaption');
        const description = descriptions.length > 0 ? descriptions[0] : undefined;
        const imageWidth = parseInt(image.getAttribute('width'), 10);

        let thumbDiv = parsoidDoc.createElement('div');
        thumbDiv.setAttribute('class', 'thumb');
        if (imageNodeClass.search('mw-halign-right') >= 0) {
            DU.appendToAttr(thumbDiv, 'class', 'tright');
        } else if (imageNodeClass.search('mw-halign-left') >= 0) {
            DU.appendToAttr(thumbDiv, 'class', 'tleft');
        } else if (imageNodeClass.search('mw-halign-center') >= 0) {
            DU.appendToAttr(thumbDiv, 'class', 'tnone');
            const centerDiv = parsoidDoc.createElement('center');
            centerDiv.appendChild(thumbDiv);
            thumbDiv = centerDiv;
        } else {
            const revAutoAlign = dump.mwMetaData.textDir === 'ltr' ? 'right' : 'left';
            DU.appendToAttr(thumbDiv, 'class', `t${revAutoAlign}`);
        }

        const thumbinnerDiv = parsoidDoc.createElement('div');
        thumbinnerDiv.setAttribute('class', 'thumbinner');
        thumbinnerDiv.setAttribute('style', `width:${imageWidth + 2}px`);

        const thumbcaptionDiv = parsoidDoc.createElement('div');
        thumbcaptionDiv.setAttribute('class', 'thumbcaption');
        const autoAlign = dump.mwMetaData.textDir === 'ltr' ? 'left' : 'right';
        thumbcaptionDiv.setAttribute('style', `text-align: ${autoAlign}`);
        if (description) {
            thumbcaptionDiv.innerHTML = description.innerHTML;
        }

        thumbinnerDiv.appendChild(isStillLinked ? image.parentNode : image);
        thumbinnerDiv.appendChild(thumbcaptionDiv);
        thumbDiv.appendChild(thumbinnerDiv);

        imageNode.parentNode.replaceChild(thumbDiv, imageNode);
    } else {
        DU.deleteNode(imageNode);
    }
}

export async function treatMedias(parsoidDoc: DominoElement, mw: MediaWiki, dump: Dump, articleId: string) {
    let mediaDependencies: string[] = [];
    /* Clean/rewrite image tags */
    const imgs = Array.from(parsoidDoc.getElementsByTagName('img'));
    const videos: DominoElement = Array.from(parsoidDoc.getElementsByTagName('video'));
    const srcCache: KVS<boolean> = {};

    for (const videoEl of videos) {
        const ret = await treatVideo(mw, dump, srcCache, articleId, videoEl);
        mediaDependencies = mediaDependencies.concat(ret.mediaDependencies);
    }

    for (const imgEl of imgs) {
        const ret = await treatImage(mw, dump, srcCache, articleId, imgEl);
        mediaDependencies = mediaDependencies.concat(ret.mediaDependencies);
    }

    /* Improve image frames */
    const figures = parsoidDoc.getElementsByTagName('figure');
    const spans = parsoidDoc.querySelectorAll('span[typeof=mw:Image/Frameless]');
    const imageNodes = Array.prototype.slice.call(figures).concat(Array.prototype.slice.call(spans));
    for (const imageNode of imageNodes) {
        treatImageFrames(mw, dump, parsoidDoc, imageNode);
    }

    return { doc: parsoidDoc, mediaDependencies };
}

async function rewriteUrls(parsoidDoc: DominoElement, articleId: string, downloader: Downloader, mw: MediaWiki, dump: Dump) {
    let mediaDependencies: string[] = [];
    /* Go through all links */
    const as = parsoidDoc.getElementsByTagName('a');
    const areas = parsoidDoc.getElementsByTagName('area');
    const linkNodes = Array.prototype.slice.call(as).concat(Array.prototype.slice.call(areas));

    await mapLimit(
        linkNodes,
        downloader.speed,
        async (linkNode) => {
            const { mediaDependencies: mediaDeps } = await rewriteUrl(articleId, mw, dump, linkNode);
            mediaDependencies = mediaDependencies.concat(mediaDeps);
        },
    );
    return { doc: parsoidDoc, mediaDependencies };
}

function applyOtherTreatments(parsoidDoc: DominoElement, dump: Dump) {
    const filtersConfig = config.filters;

    /* Don't need <link> and <input> tags */
    const nodesToDelete: Array<{ class?: string, tag?: string, filter?: (n: any) => boolean }> = [{ tag: 'link' }, { tag: 'input' }];

    /* Remove "map" tags if necessary */
    if (dump.nopic) {
        nodesToDelete.push({ tag: 'map' });
    }

    /* Remove useless DOM nodes without children */
    function emptyChildFilter(n: any) {
        return !n.innerHTML;
    }
    nodesToDelete.push({ tag: 'li', filter: emptyChildFilter });
    nodesToDelete.push({ tag: 'span', filter: emptyChildFilter });

    /* Remove gallery boxes if pics need stripping of if it doesn't have thumbs */
    nodesToDelete.push({
        class: 'gallerybox',
        filter(n) {
            return !n.getElementsByTagName('img').length
                && !n.getElementsByTagName('audio').length
                && !n.getElementsByTagName('video').length;
        },
    });
    nodesToDelete.push({
        class: 'gallery',
        filter(n) {
            return !n.getElementsByClassName('gallerybox').length;
        },
    });

    /* Remove element with black listed CSS classes */
    filtersConfig.cssClassBlackList.forEach((classname: string) => {
        nodesToDelete.push({ class: classname });
    });

    if (dump.nodet) {
        filtersConfig.nodetCssClassBlackList.forEach((classname: string) => {
            nodesToDelete.push({ class: classname });
        });
    }

    /* Remove element with black listed CSS classes and no link */
    filtersConfig.cssClassBlackListIfNoLink.forEach((classname: string) => {
        nodesToDelete.push({
            class: classname,
            filter(n) {
                return n.getElementsByTagName('a').length === 0;
            },
        });
    });

    /* Delete them all */
    nodesToDelete.forEach((t) => {
        let nodes;
        if (t.tag) {
            nodes = parsoidDoc.getElementsByTagName(t.tag);
        } else if (t.class) {
            nodes = parsoidDoc.getElementsByClassName(t.class);
        } else {
            return; /* throw error? */
        }

        const f = t.filter;
        // tslint:disable-next-line:prefer-for-of
        for (let i = 0; i < nodes.length; i += 1) {
            if (!f || f(nodes[i])) {
                DU.deleteNode(nodes[i]);
            }
        }
    });

    /* Go through all reference calls */
    const spans = parsoidDoc.getElementsByTagName('span');
    // tslint:disable-next-line:prefer-for-of
    for (let i = 0; i < spans.length; i += 1) {
        const span = spans[i];
        const rel = span.getAttribute('rel');
        if (rel === 'dc:references') {
            const sup = parsoidDoc.createElement('sup');
            if (span.innerHTML) {
                sup.id = span.id;
                sup.innerHTML = span.innerHTML;
                span.parentNode.replaceChild(sup, span);
            } else {
                DU.deleteNode(span);
            }
        }
    }

    /* Remove element with id in the blacklist */
    filtersConfig.idBlackList.forEach((id) => {
        const node = parsoidDoc.getElementById(id);
        if (node) {
            DU.deleteNode(node);
        }
    });

    /* Force display of element with that CSS class */
    filtersConfig.cssClassDisplayList.map((classname: string) => {
        const nodes = parsoidDoc.getElementsByClassName(classname);
        // tslint:disable-next-line:prefer-for-of
        for (let i = 0; i < nodes.length; i += 1) {
            nodes[i].style.removeProperty('display');
        }
    });

    /* Remove empty paragraphs */
    if (!dump.opts.keepEmptyParagraphs) {
        for (let level = 5; level > 0; level--) {
            const paragraphNodes = parsoidDoc.getElementsByTagName(`h${level}`);
            // tslint:disable-next-line:prefer-for-of
            for (let i = 0; i < paragraphNodes.length; i += 1) {
                const paragraphNode = paragraphNodes[i];
                const nextElementNode = DU.nextElementSibling(paragraphNode);
                const isSummary = paragraphNode.parentElement.nodeName === 'SUMMARY';
                if (!isSummary) {
                    /* No nodes */
                    if (!nextElementNode) {
                        DU.deleteNode(paragraphNode);
                    } else {
                        /* Delete if nextElementNode is a paragraph with <= level */
                        const nextElementNodeTag = nextElementNode.tagName.toLowerCase();
                        if (
                            nextElementNodeTag.length > 1
                            && nextElementNodeTag[0] === 'h'
                            && !isNaN(nextElementNodeTag[1])
                            && nextElementNodeTag[1] <= level
                        ) {
                            DU.deleteNode(paragraphNode);
                        }
                    }
                }
            }
        }
    }

    /* Clean the DOM of all uncessary code */
    const allNodes = parsoidDoc.getElementsByTagName('*');
    // tslint:disable-next-line:prefer-for-of
    for (let i = 0; i < allNodes.length; i += 1) {
        const node = allNodes[i];
        node.removeAttribute('data-parsoid');
        node.removeAttribute('typeof');
        node.removeAttribute('about');
        node.removeAttribute('data-mw');

        if (node.getAttribute('rel') && node.getAttribute('rel').substr(0, 3) === 'mw:') {
            node.removeAttribute('rel');
        }

        /* Remove a few css calls */
        filtersConfig.cssClassCallsBlackList.map((classname: string) => {
            if (node.getAttribute('class')) {
                node.setAttribute('class', node.getAttribute('class').replace(classname, ''));
            }
        });
    }

    return parsoidDoc;
}

async function templateArticle(parsoidDoc: DominoElement, moduleDependencies: any, mw: MediaWiki, dump: Dump, articleId: string, articleDetail: ArticleDetail): Promise<string | Buffer> {
    const {
        jsConfigVars,
        jsDependenciesList,
        styleDependenciesList,
    } = moduleDependencies as {
        jsConfigVars: string | RegExpExecArray,
        jsDependenciesList: string[],
        styleDependenciesList: string[],
    };

    const htmlTemplateDoc = domino.createDocument(
        htmlTemplateCode(articleId)
            .replace('__ARTICLE_CONFIGVARS_LIST__', jsConfigVars !== '' ? genHeaderScript(config, 'jsConfigVars', articleId) : '')
            .replace(
                '__ARTICLE_JS_LIST__',
                jsDependenciesList.length !== 0
                    ? jsDependenciesList.map((oneJsDep) => genHeaderScript(config, oneJsDep, articleId)).join('\n')
                    : '',
            )
            .replace(
                '__ARTICLE_CSS_LIST__',
                styleDependenciesList.length !== 0
                    ? styleDependenciesList.map((oneCssDep) => genHeaderCSSLink(config, oneCssDep, articleId)).join('\n')
                    : '',
            ),
    );

    /* Create final document by merging template and parsoid documents */
    htmlTemplateDoc.getElementById('mw-content-text').style.setProperty('direction', dump.mwMetaData.textDir);
    htmlTemplateDoc.getElementById('mw-content-text').innerHTML = parsoidDoc.getElementsByTagName('body')[
        0
    ].innerHTML;

    /* Title */
    htmlTemplateDoc.getElementsByTagName('title')[0].innerHTML = htmlTemplateDoc.getElementById('title_0')
        ? htmlTemplateDoc.getElementById('title_0').textContent
        : articleId.replace(/_/g, ' ');
    DU.deleteNode(htmlTemplateDoc.getElementById('titleHeading'));

    /* Subpage */
    if (isSubpage(articleId, mw) && dump.mwMetaData.mainPage !== articleId) {
        const headingNode = htmlTemplateDoc.getElementById('mw-content-text');
        const subpagesNode = htmlTemplateDoc.createElement('span');
        const parents = articleId.split('/');
        parents.pop();
        let subpages = '';
        let parentPath = '';
        await Promise.all(
            parents.map(async (parent) => {
                const label = parent.replace(/_/g, ' ');
                const isParentMirrored = await isMirrored(parentPath + parent);
                subpages
                    += `&lt; ${
                    isParentMirrored
                        ? `<a href="${dump.getArticleUrl(parentPath + parent)}" title="${label}">`
                        : ''
                    }${label
                    }${isParentMirrored ? '</a> ' : ' '}`;
                parentPath += `${parent}/`;
            }),
        );
        subpagesNode.innerHTML = subpages;
        subpagesNode.setAttribute('class', 'subpages');
        headingNode.parentNode.insertBefore(subpagesNode, headingNode);
    }

    /* Set footer */
    const div = htmlTemplateDoc.createElement('div');
    const rev = articleDetail.revisions && articleDetail.revisions.length ? articleDetail.revisions[0] : null;
    try {
        if (rev) {
            /* Revision date */
            const oldId = rev.revid;
            const timestamp = rev.timestamp;
            const date = new Date(timestamp);
            div.innerHTML = footerTemplate({
                articleId: encodeURIComponent(articleId),
                webUrl: mw.webUrl,
                creator: dump.mwMetaData.creator,
                oldId,
                date: date.toISOString().substring(0, 10),
                strings: dump.strings,
            });
            htmlTemplateDoc.getElementById('mw-content-text').appendChild(div);
            addNoIndexCommentToElement(div);
        }

        /* Geo-coordinates */
        if (articleDetail.coordinates && articleDetail.coordinates.length) {
            const coords = articleDetail.coordinates[0];
            const geoCoordinates = `${coords.lat};${coords.lon}`;
            const metaNode = htmlTemplateDoc.createElement('meta');
            metaNode.name = 'geo.position';
            metaNode.content = geoCoordinates;
            htmlTemplateDoc.getElementsByTagName('head')[0].appendChild(metaNode);
        }

        let outHtml = htmlTemplateDoc.documentElement.outerHTML;

        if (dump.opts.minifyHtml) {
            outHtml = htmlMinifier.minify(outHtml, {
                removeComments: true,
                conservativeCollapse: true,
                collapseBooleanAttributes: true,
                removeRedundantAttributes: true,
                removeEmptyAttributes: true,
                minifyCSS: true,
            });
        }

        return `<!DOCTYPE html>\n` + outHtml;
    } catch (err) {
        throw new Error(`Unable to get the details from redis for article ${articleId}: \n${err}`);
    }
}

function addNoIndexCommentToElement(element: DominoElement) {
    const slices = element.parentElement.innerHTML.split(element.outerHTML);
    element.parentElement.innerHTML = `${slices[0]}<!--htdig_noindex-->${element.outerHTML}<!--/htdig_noindex-->${slices[1]}`;
}

function isSubpage(id: string, mw: MediaWiki) {
    if (id && id.indexOf('/') >= 0) {
        const namespace = id.indexOf(':') >= 0 ? id.substring(0, id.indexOf(':')).replace(/ /g, mw.spaceDelimiter) : '';
        const ns = mw.namespaces[namespace]; // namespace already defined
        if (ns !== undefined) {
            return ns.allowedSubpages;
        }
    }
    return false;
}

export function isMirrored(id: string) {
    return articleDetailXId.get(id);
}
