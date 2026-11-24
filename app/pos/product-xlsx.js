(function (global) {
  const headers = ['SKU', 'Nama Produk', 'Kategori', 'Harga Jual', 'Modal', 'Stok'];
  const columnLetters = (index) => {
    let value = '';
    for (index += 1; index; index = Math.floor((index - 1) / 26))
      value = String.fromCharCode(65 + ((index - 1) % 26)) + value;
    return value;
  };
  const escapeXml = (value) =>
    String(value).replace(
      /[<>&'"]/g,
      (character) =>
        ({
          '<': '&lt;',
          '>': '&gt;',
          '&': '&amp;',
          "'": '&apos;',
          '"': '&quot;',
        })[character],
    );

  function createTemplate() {
    const { strToU8, zipSync } = global.fflate;
    const cells = headers
      .map(
        (header, index) =>
          `<c r="${columnLetters(index)}1" t="inlineStr"><is><t>${escapeXml(header)}</t></is></c>`,
      )
      .join('');
    const files = {
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '</Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
      'xl/workbook.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Produk" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '</Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<dimension ref="A1:${columnLetters(headers.length - 1)}1"/><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
      ),
    };
    return zipSync(files, { level: 6 });
  }

  function parseProducts(arrayBuffer) {
    const { strFromU8, unzipSync } = global.fflate;
    const files = unzipSync(new Uint8Array(arrayBuffer));
    const readXml = (path) => {
      const file = files[path];
      if (!file) return null;
      const document = new DOMParser().parseFromString(strFromU8(file), 'application/xml');
      if (document.getElementsByTagName('parsererror').length)
        throw new Error(`Isi Excel tidak valid (${path}).`);
      return document;
    };
    const workbook = readXml('xl/workbook.xml');
    const relationships = readXml('xl/_rels/workbook.xml.rels');
    if (!workbook || !relationships) throw new Error('File bukan workbook Excel yang valid.');

    const firstSheet = workbook.getElementsByTagNameNS('*', 'sheet')[0];
    if (!firstSheet) throw new Error('Workbook tidak memiliki sheet produk.');
    const relationshipId =
      firstSheet.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id',
      ) || firstSheet.getAttribute('r:id');
    const relationship = [...relationships.getElementsByTagNameNS('*', 'Relationship')].find(
      (item) => item.getAttribute('Id') === relationshipId,
    );
    if (!relationship) throw new Error('Sheet produk tidak ditemukan.');
    const target = relationship.getAttribute('Target');
    const sheetPath = target.startsWith('/')
      ? target.slice(1)
      : `xl/${target}`.replace(/\/\.\//g, '/');
    const sheet = readXml(sheetPath);
    if (!sheet) throw new Error('Isi sheet produk tidak ditemukan.');
    const sharedStringsDocument = readXml('xl/sharedStrings.xml');
    const sharedStrings = sharedStringsDocument
      ? [...sharedStringsDocument.getElementsByTagNameNS('*', 'si')].map((item) =>
          [...item.getElementsByTagNameNS('*', 't')].map((text) => text.textContent || '').join(''),
        )
      : [];
    const columnIndex = (reference) => {
      let index = 0;
      for (const character of reference.match(/^[A-Z]+/i)?.[0] || '') {
        index = index * 26 + character.toUpperCase().charCodeAt(0) - 64;
      }
      return index - 1;
    };
    const cellValue = (cell) => {
      if (cell.getElementsByTagNameNS('*', 'f').length)
        throw new Error('Rumus Excel tidak didukung; masukkan nilainya langsung.');
      const type = cell.getAttribute('t');
      if (type === 'inlineStr')
        return [...cell.getElementsByTagNameNS('*', 't')]
          .map((text) => text.textContent || '')
          .join('');
      const value = cell.getElementsByTagNameNS('*', 'v')[0]?.textContent || '';
      if (type === 's') return sharedStrings[Number(value)] ?? '';
      if (type === 'b') return value === '1';
      if (!value || type === 'str') return value;
      const number = Number(value);
      return Number.isFinite(number) ? number : value;
    };
    const rows = [...sheet.getElementsByTagNameNS('*', 'row')];
    if (!rows.length) throw new Error('Sheet produk masih kosong.');
    const headerCells = [...rows[0].getElementsByTagNameNS('*', 'c')];
    const headerMap = new Map(
      headerCells.map((cell) => [
        String(cellValue(cell)).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '),
        columnIndex(cell.getAttribute('r')),
      ]),
    );
    const requiredHeaders = ['sku', 'nama produk', 'kategori', 'harga jual', 'modal', 'stok'];
    const missingHeader = requiredHeaders.find((header) => !headerMap.has(header));
    if (missingHeader) throw new Error(`Kolom wajib tidak ditemukan: ${missingHeader}.`);

    return rows.slice(1).flatMap((row) => {
      const values = new Map();
      for (const cell of row.getElementsByTagNameNS('*', 'c'))
        values.set(columnIndex(cell.getAttribute('r')), cellValue(cell));
      const get = (header) => values.get(headerMap.get(header)) ?? '';
      const product = {
        rowNumber: Number(row.getAttribute('r')) || 0,
        sku: get('sku'),
        name: get('nama produk'),
        category: get('kategori'),
        price: get('harga jual'),
        cost: get('modal'),
        stock: get('stok'),
      };
      return ['sku', 'nama produk', 'kategori', 'harga jual', 'modal', 'stok'].some(
        (header) => get(header) !== '',
      )
        ? [product]
        : [];
    });
  }

  global.ProductXlsx = { createTemplate, parseProducts };
})(window);
