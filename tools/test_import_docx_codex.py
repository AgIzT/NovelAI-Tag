# -*- coding: utf-8 -*-

import unittest
from xml.etree import ElementTree as ET

try:
    from tools.import_docx_codex import (
        NS,
        Paragraph,
        build_valid_titles,
        paragraph_blips,
        paragraph_style,
        paragraph_text,
        parse_entry,
    )
except ModuleNotFoundError:
    from import_docx_codex import (
        NS,
        Paragraph,
        build_valid_titles,
        paragraph_blips,
        paragraph_style,
        paragraph_text,
        parse_entry,
    )


DOCUMENT_XML = f"""
<w:document xmlns:w="{NS['w']}" xmlns:a="{NS['a']}" xmlns:r="{NS['r']}">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="2p4pgv"/></w:pPr>
      <w:r><w:t>白</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>正面tag：</w:t></w:r>
      <w:r><w:drawing><w:txbxContent>
        <w:p><w:r><w:t>artist:yao liao wang,</w:t></w:r></w:p>
        <w:p><w:r><w:t>1girl,solo,on bed,</w:t></w:r></w:p>
        <w:p><w:r><w:t>,best quality,absurdres,</w:t></w:r></w:p>
      </w:txbxContent></w:drawing></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>反面tag：</w:t></w:r>
      <w:r><w:drawing><w:txbxContent>
        <w:p><w:r><w:t>bad anatomy,watermark,</w:t></w:r></w:p>
      </w:txbxContent></w:drawing></w:r>
    </w:p>
  </w:body>
</w:document>
"""


class ImportDocxCodexTests(unittest.TestCase):
    def setUp(self):
        self.root = ET.fromstring(DOCUMENT_XML)
        self.paragraphs = self.root.findall(".//w:p", NS)

    def test_outer_paragraph_excludes_nested_text_box_paragraphs(self):
        positive_outer = self.paragraphs[1]
        self.assertEqual(paragraph_text(positive_outer), "正面tag：")
        self.assertEqual(
            [paragraph_text(p) for p in self.paragraphs[2:5]],
            [
                "artist:yao liao wang,",
                "1girl,solo,on bed,",
                ",best quality,absurdres,",
            ],
        )

    def test_outer_paragraph_excludes_nested_image_relationships(self):
        xml = f"""
        <w:p xmlns:w="{NS['w']}" xmlns:a="{NS['a']}" xmlns:r="{NS['r']}">
          <w:r><w:drawing><a:blip r:embed="rIdOuter"/></w:drawing></w:r>
          <w:r><w:drawing><w:txbxContent><w:p>
            <w:r><w:drawing><a:blip r:embed="rIdNested"/></w:drawing></w:r>
          </w:p></w:txbxContent></w:drawing></w:r>
        </w:p>
        """
        outer = ET.fromstring(xml)
        nested = outer.find(".//w:p", NS)
        rels = {
            "rIdOuter": "word/media/outer.png",
            "rIdNested": "word/media/nested.png",
        }
        self.assertEqual(paragraph_blips(outer, rels), ["word/media/outer.png"])
        self.assertEqual(paragraph_blips(nested, rels), ["word/media/nested.png"])

    def test_text_box_prompt_is_parsed_once(self):
        items = []
        for paragraph in self.paragraphs:
            text = paragraph_text(paragraph)
            if text:
                items.append(
                    Paragraph(
                        len(items),
                        paragraph_style(paragraph),
                        text,
                        [],
                    )
                )

        valid_titles, failures = build_valid_titles(items)
        self.assertFalse(failures)
        self.assertEqual(len(valid_titles), 1)
        title_idx = next(iter(valid_titles))
        entry, _medias, _info = parse_entry(
            items,
            title_idx,
            len(items),
            "jiegou_yuandian",
            1,
            set(valid_titles),
        )

        self.assertEqual(
            entry["tags"],
            "artist:yao liao wang,\n"
            "1girl,solo,on bed,\n"
            ",best quality,absurdres,",
        )
        self.assertEqual(entry["negative"], "bad anatomy,watermark,")


if __name__ == "__main__":
    unittest.main()
