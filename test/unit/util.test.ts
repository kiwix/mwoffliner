import './bootstrap.test';
import test from 'blue-tape';
import { encodeArticleIdForZimHtmlUrl, interpolateTranslationString } from 'src/util';
import { testHtmlRewritingE2e } from 'test/util';

test('util -> interpolateTranslationString', async (t) => {
    t.equals(interpolateTranslationString('Hello world', {}), 'Hello world');
    t.equals(interpolateTranslationString('Hello ${name}', { name: 'John' }), 'Hello John');
    t.equals(interpolateTranslationString('Hello ${name} ${lastname}, bye ${name}', {
        name: 'John',
        lastname: 'Smith',
    }), 'Hello John Smith, bye John');
});

test('Encoding ArticleId for Zim HTML Url', async(t) => {
     const articles = [
        'Que_faire_?',                        'Que_faire_%3F',
        'Que_faire_?_(Lénine)',               'Que_faire_%3F_(L%C3%A9nine)',
        'Random_#hashtag',                    'Random_%23hashtag',
        `Guidelines:Règles_d'édition`,        `Guidelines%3AR%C3%A8gles_d'%C3%A9dition`,
        'Avanti!',                            'Avanti!',
        'McCormick_Tribune_Plaza_&_Ice Rink', 'McCormick_Tribune_Plaza_%26_Ice%20Rink',
        '2_+_2_=_5',                          '2_%2B_2_%3D_5',
        `Guidelines:Règles d'édition`,        `Guidelines%3AR%C3%A8gles%20d'%C3%A9dition`,
        'something/random/todo',              'something/random/todo',
        'Michael_Jackson',                    'Michael_Jackson',
        undefined,                            undefined
    ];

    while (articles.length) {
        const unencoded = articles.shift();
        const   encoded = articles.shift();
        t.equal(encoded, encodeArticleIdForZimHtmlUrl(unencoded), `encodeArticleIdForZimHtmlUrl() encoding`);
    }
});

test('wikitext comparison', async(t) => {
    testHtmlRewritingE2e(
        t,
        `An [[isolated system]] remains the system is free.`,
        `<p id="mwAQ">An <a rel="mw:WikiLink" href="./Isolated_system" title="Isolated system" id="mwAg">isolated system</a> remains the system is free.</p>`,
        'HTML and Wikitext match')
})
