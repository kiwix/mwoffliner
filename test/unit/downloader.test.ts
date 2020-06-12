import './bootstrap.test.ts';
import test from 'blue-tape';
import tapePromise from 'tape-promise';
import Downloader from 'src/Downloader';
import MediaWiki from 'src/MediaWiki';
import Axios from 'axios';
import { mkdirPromise } from 'src/util';
import S3 from 'src/S3';
import rimraf from 'rimraf';
import { Dump } from 'src/Dump';
import { articleDetailXId } from 'src/stores';
import logger from 'src/Logger';
import 'dotenv/config';

test('Downloader class', async (t) => {
    const mw = new MediaWiki({
        base: 'https://en.wikipedia.org',
        getCategories: true,
    } as any);

    const cacheDir = `cac/dumps-${Date.now()}/`;
    await mkdirPromise(cacheDir);
    const downloader = new Downloader({ mw, uaString: '', speed: 1, reqTimeout: 1000 * 60, useDownloadCache: true, downloadCacheDirectory: cacheDir, noLocalParserFallback: false, forceLocalParser: false, optimisationCacheUrl: '' });

    await mw.getMwMetaData(downloader);
    await downloader.checkCapabilities();

    // const remoteMcsUrl = downloader.mcsUrl;
    // const remoteParsoidUrl = downloader.parsoidFallbackUrl;

    // const mcsHandle = await downloader.initLocalMcs();

    // t.notEqual(remoteMcsUrl, downloader.mcsUrl, 'Initializing local MCS changes mcsUrl');
    // t.notEqual(remoteParsoidUrl, downloader.parsoidFallbackUrl, 'Initializing local Parsoid changes parsoidFallbackUrl');

    const queryRet = await downloader.query(`?action=query&meta=siteinfo&siprop=statistics&format=json`);
    t.ok(!!queryRet, 'downloader.query returns valid JSON');

    const JSONRes = await downloader.getJSON(`https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json`);
    t.ok(!!JSONRes, 'downloader.getJSON returns valid JSON');

    const urlExists = await downloader.canGetUrl(`https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json`);
    t.ok(urlExists, 'downloader.canGetUrl returns valid answer (positive)');

    const urlNotExists = await downloader.canGetUrl(`https://en.wikipedia.org/w/thisisa404`);
    t.ok(!urlNotExists, 'downloader.canGetUrl returns valid answer (negative)');

    try {
        await downloader.getJSON(`https://en.wikipedia.org/w/thisisa404`);
    } catch (err) {
        t.ok(true, 'getJSON throws on non-existant url');
        t.equal(err.response.status, 404, 'getJSON response status for non-existant url is 404');
    }

    const contentRes = await downloader.downloadContent(`https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/London_Montage_L.jpg/275px-London_Montage_L.jpg`);
    t.ok(!!contentRes.responseHeaders, 'downloader.downloadContent returns');

    try {
        await downloader.downloadContent(`https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/thisdoesnotexist.jpg`);
    } catch (err) {
        t.ok(true, 'downloader.downloadContent throws on non-existant url');
        t.equal(err.response.status, 404, 'downloadContent response status for non-existant url is 404');
    }

    const articleDetailsRet = await downloader.getArticleDetailsIds(['London', 'United_Kingdom', 'Paris', 'Zurich', 'THISARTICLEDOESNTEXIST', 'Category:Container_categories']);
    articleDetailXId.setMany(articleDetailsRet);
    const { London, Paris, Zurich, United_Kingdom, THISARTICLEDOESNTEXIST } = articleDetailsRet;
    t.ok(!!London, 'getArticleDetailsIds Scraped "London" successfully');
    t.ok(!!United_Kingdom, 'getArticleDetailsIds Scraped "United_Kingdom" successfully');
    t.ok(!!Paris, 'getArticleDetailsIds Scraped "Paris" successfully');
    t.ok(!!Zurich, 'getArticleDetailsIds Scraped "Zurich" successfully');
    t.ok(typeof (THISARTICLEDOESNTEXIST as any).missing === 'string', 'getArticleDetailsIds Didn\'t scrape "THISARTICLEDOESNTEXIST" successfully');

    const { gapContinue, articleDetails } = await downloader.getArticleDetailsNS(0);
    t.ok(!!gapContinue, 'NS query returns a gapContinue');
    t.ok(Object.keys(articleDetails).length > 10, 'NS query returns multiple articles');
    const secondNsRet = await downloader.getArticleDetailsNS(0, gapContinue);
    t.ok(!!secondNsRet.gapContinue, 'Second NS query returns a gapContinue');

    try {
        await downloader.downloadContent('');
    } catch (err) {
        t.ok(true, 'downloadContent throws when empty string is passed');
    }

    const { data: LondonDetail } = await Axios.get(`${downloader.restApiUrl}London`);
    const [imgToGet] = Object.values(LondonDetail.lead.image.urls);

    const LondonImage = await downloader.downloadContent(imgToGet as string);
    t.ok(!!LondonImage.responseHeaders['content-type'].includes('image/'), 'downloadContent successfully downloaded an image');

    const mwMetadata = await mw.getMwMetaData(downloader);
    const dump = new Dump('', {} as any, mwMetadata);

    const LondonArticle = await downloader.getArticle('London', dump);
    t.equal(LondonArticle.length, 1, 'getArticle of "London" returns one article');

    const PaginatedArticle = await downloader.getArticle('Category:Container_categories', dump);
    t.ok(PaginatedArticle.length > 100, 'Categories with many subCategories are paginated');

    try {
        await downloader.getArticle('NeverExistingArticle', dump);
    } catch (err) {
        t.ok(true, 'downloader.downloadContent throws on non-existent article id');
        t.equal(err.response.status, 404, 'getArticle response status for non-existent article id is 404');
    }

    rimraf.sync(cacheDir);

    const isPngFile =  downloader.isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.svg.png');
    t.assert(isPngFile, 'Checked Image type: png');

    const isJpgFile =  downloader.isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.JPG');
    t.assert(isJpgFile, 'Checked Image type: jpg');

    const isSvgFile =  downloader.isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.svg');
    t.assert(isSvgFile, 'Checked Image type: svg');

    const isJpegFile =  downloader.isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.JPEG');
    t.assert(isJpegFile, 'Checked Image type: jpeg');

    const isgifFile =  downloader.isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.gif');
    t.assert(isgifFile, 'Checked Image type: gif');

    const isnotImage =  downloader.isImageUrl('https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json');
    t.assert(!isnotImage, 'Url is not image type');

    const isEmptyString =  downloader.isImageUrl('');
    t.assert(!isEmptyString, 'Url is empty string');

    const imageHasNoExtension =  downloader.isImageUrl('https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x');
    t.assert(!imageHasNoExtension, 'Image Url has no extension');

    const extensionIsUndefined =  downloader.isImageUrl('https://bm.wikipedia.org/static/images/project-logos/undefined');
    t.assert(!extensionIsUndefined, 'Image Url extension is undefined');
    // TODO: find a way to get service-runner to stop properly
    // await mcsHandle.stop();
});

const _test = tapePromise(test);

_test('Downloader class with optimisation', async (t) => {
    if (!process.env.BUCKET_NAME_TEST) {
        logger.log('Skip S3 tests in Downloader class');
        return;
    }

    const mw = new MediaWiki({
        base: 'https://en.wikipedia.org',
        getCategories: true,
    } as any);

    const cacheDir = `cac/dumps-${Date.now()}/`;
    await mkdirPromise(cacheDir);
    const s3 = new S3(process.env.BASE_URL_TEST, {
        bucketName: process.env.BUCKET_NAME_TEST,
        keyId: process.env.KEY_ID_TEST,
        secretAccessKey: process.env.SECRET_ACCESS_KEY_TEST,
    });
    const downloader = new Downloader({ mw, uaString: '', speed: 1, reqTimeout: 1000 * 60, useDownloadCache: true, downloadCacheDirectory: cacheDir, noLocalParserFallback: false, forceLocalParser: false, optimisationCacheUrl: 'random-string' , s3});

    await s3.initialise();

    const testImage = 'https://bm.wikipedia.org/static/images/project-logos/bmwiki-2x.png';
    // Test for image where etag is not present
    const etagNotPresent = await downloader.downloadContent(`https://en.wikipedia.org/w/extensions/WikimediaBadges/resources/images/badge-silver-star.png?70a8c`);
    t.equals(etagNotPresent.responseHeaders.etag, undefined , 'Etag Not Present');

    // Strip http(s) from url
    const httpOrHttpsRemoved = downloader.stripHttpFromUrl(testImage);
    t.assert(httpOrHttpsRemoved, 'http removed from url');

    // Flow of Image Caching
    // Delete the image already present in S3
    await s3.deleteBlob({ Bucket: process.env.BUCKET_NAME_TEST, Key: httpOrHttpsRemoved });
    t.ok(true, 'Image deleted from S3');

    // Check if image exists after deleting from S3
    const imageNotExists = await s3.downloadIfPossible(httpOrHttpsRemoved, testImage);
    t.equals(imageNotExists, undefined, 'Image not exists in S3 after deleting');
    // Uploads the image to S3
    await downloader.downloadContent(testImage);
});
