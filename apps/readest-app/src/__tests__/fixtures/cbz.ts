export const makeCbzFixture = async ({
  comicInfo,
  comicInfoPath = 'ComicInfo.xml',
  imageCount,
}: {
  comicInfo?: string;
  comicInfoPath?: string;
  imageCount: number;
}): Promise<File> => {
  const { BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js');
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'));
  for (let i = 0; i < imageCount; i++) {
    await writer.add(`${i}.png`, new TextReader(`image-${i}`));
  }
  if (comicInfo) {
    await writer.add(comicInfoPath, new TextReader(comicInfo));
  }
  const blob = await writer.close();
  // zip.js yields a Blob from another realm (Node's); jsdom's File constructor
  // doesn't recognize it as a BlobPart and stringifies it to "[object Blob]".
  // Hand over raw bytes instead so the File holds the actual archive.
  return new File([await blob.arrayBuffer()], 'fixture.cbz', {
    type: 'application/vnd.comicbook+zip',
  });
};
