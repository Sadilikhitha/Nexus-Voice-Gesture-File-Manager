import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slideTextFromXml, slideNumber, isSlideXml, isShowableImage } from '../src/preview/pptx';

test('pptx slide text extraction', () => {
  const xml = '<p:sp><a:p><a:r><a:t>Q3 &amp; Q4 Plan</a:t></a:r></a:p><a:p><a:r><a:t>Launch </a:t></a:r><a:r><a:t>date</a:t></a:r></a:p><a:p></a:p></p:sp>';
  assert.deepEqual(slideTextFromXml(xml), ['Q3 & Q4 Plan', 'Launch date']);
});
test('slide ordering & media filters', () => {
  assert.ok(isSlideXml('ppt/slides/slide10.xml') && !isSlideXml('ppt/slides/_rels/slide1.xml.rels'));
  assert.ok(slideNumber('ppt/slides/slide10.xml') > slideNumber('ppt/slides/slide2.xml'));
  assert.ok(isShowableImage('ppt/media/image1.PNG') && !isShowableImage('ppt/media/image1.emf'));
});
