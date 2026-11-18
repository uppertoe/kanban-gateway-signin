/*!
 * Copyright (c) 2024 PLANKA Software GmbH
 * Licensed under the Fair Use License: https://github.com/plankanban/planka/blob/master/LICENSE.md
 */

const { v4: uuid } = require('uuid');
const { rimraf } = require('rimraf');
const { fileTypeFromFile } = require('file-type');
const sharp = require('sharp');

const { Readable } = require('stream');

const { MAX_SIZE_TO_PROCESS_AS_IMAGE } = require('../../../constants');

// Longest side of a stored background, and the WebP quality of the
// background and of its picker thumbnail.
const BACKGROUND_MAX_SIZE = 2560;
const BACKGROUND_QUALITY = 80;
const THUMBNAIL_QUALITY = 75;

module.exports = {
  inputs: {
    file: {
      type: 'json',
      required: true,
    },
  },

  exits: {
    fileIsNotImage: {},
  },

  async fn(inputs) {
    const fileManager = sails.hooks['file-manager'].getInstance();

    const fileType = await fileTypeFromFile(inputs.file.fd);
    const { mime: mimeType = null } = fileType || {};
    const { size: uploadedSize } = inputs.file;

    if (
      !mimeType ||
      !mimeType.startsWith('image/') ||
      uploadedSize > MAX_SIZE_TO_PROCESS_AS_IMAGE
    ) {
      await rimraf(inputs.file.fd);
      throw 'fileIsNotImage';
    }

    let image = sharp(inputs.file.fd, {
      animated: true,
    });

    let metadata;
    try {
      metadata = await image.metadata();
    } catch (error) {
      await rimraf(inputs.file.fd);
      throw 'fileIsNotImage';
    }

    if (metadata.orientation && metadata.orientation > 4) {
      image = image.rotate();
    }

    // Local modification (see GATEWAY.md, "Other changes"): a background is
    // stored as WebP, no larger than a large desktop screen needs, instead of
    // as the uploaded file. An animated image stays animated.
    let original;
    let outside360;
    try {
      [original, outside360] = await Promise.all([
        image
          .clone()
          .resize(BACKGROUND_MAX_SIZE, BACKGROUND_MAX_SIZE, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: BACKGROUND_QUALITY })
          .toBuffer(),
        image
          .clone()
          .resize(360, 360, {
            fit: 'outside',
            withoutEnlargement: true,
          })
          .webp({ quality: THUMBNAIL_QUALITY })
          .toBuffer(),
      ]);
    } catch (error) {
      await rimraf(inputs.file.fd);
      throw 'fileIsNotImage';
    }

    const extension = 'webp';
    const size = original.length;

    const { id: uploadedFileId } = await UploadedFile.qm.createOne({
      mimeType: 'image/webp',
      size,
      id: uuid(),
      type: UploadedFile.Types.BACKGROUND_IMAGE,
    });

    const dirPathSegment = `${sails.config.custom.backgroundImagesPathSegment}/${uploadedFileId}`;

    try {
      await Promise.all([
        fileManager.save(
          `${dirPathSegment}/original.${extension}`,
          Readable.from([original]),
          'image/webp',
        ),
        fileManager.save(
          `${dirPathSegment}/outside-360.${extension}`,
          Readable.from([outside360]),
          'image/webp',
        ),
      ]);
    } catch (error) {
      sails.log.warn(error.stack);

      await fileManager.deleteDir(dirPathSegment);
      await rimraf(inputs.file.fd);
      await UploadedFile.qm.deleteOne(uploadedFileId);

      throw 'fileIsNotImage';
    }

    await rimraf(inputs.file.fd);

    return {
      uploadedFileId,
      extension,
      size,
    };
  },
};
