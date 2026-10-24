#!/usr/bin/env python3
"""Génère la copie conservable et le module serveur depuis la même page HTML.

Pour toute modification contractuelle, choisir une nouvelle version dans la page.
--check vérifie les artefacts sans les réécrire. Aucun appel réseau.
"""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urljoin
import argparse
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]


class TexteContrat(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.liens = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('h2', 'p', 'address', 'section', 'div'):
            self.parts.append('\n\n')
        if tag == 'br':
            self.parts.append('\n')
        if tag == 'a':
            href = attrs.get('href', '')
            self.liens.append(urljoin('https://younousjonas.com/', href) if href and not href.startswith(('mailto:', 'tel:', '#')) else '')

    def handle_endtag(self, tag):
        if tag == 'a' and self.liens:
            href = self.liens.pop()
            if href:
                self.parts.append(' (' + href + ')')
        if tag in ('h2', 'p', 'address', 'section', 'div'):
            self.parts.append('\n\n')

    def handle_data(self, text):
        self.parts.append(text)


def produire():
    page = (ROOT / 'conditions-bd.html').read_text(encoding='utf-8')
    def attribut(nom):
        match = re.search(r'\b' + re.escape(nom) + r'="([^"]+)"', page)
        if not match:
            raise ValueError('Attribut absent : ' + nom)
        return match.group(1)
    version = attribut('data-conditions-version')
    date_version = attribut('data-conditions-date')
    statut_page = attribut('data-publication-status')
    if not re.fullmatch(r'bd-[A-Za-z0-9-]+', version) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date_version):
        raise ValueError('Version ou date invalide')
    if statut_page not in ('draft', 'published'):
        raise ValueError('Statut inconnu : draft ou published attendu')
    debut = '<!-- CONDITIONS-CONTRACTUELLES-DEBUT -->'
    fin = '<!-- CONDITIONS-CONTRACTUELLES-FIN -->'
    if page.count(debut) != 1 or page.count(fin) != 1:
        raise ValueError('Bornes du texte contractuel absentes ou multiples')
    fragment = page.split(debut, 1)[1].split(fin, 1)[0]
    parser = TexteContrat()
    parser.feed(fragment)
    corps = '\n'.join(re.sub(r'[ \t\r\f\v]+', ' ', ligne).strip() for ligne in ''.join(parser.parts).split('\n'))
    corps = re.sub(r'\n{3,}', '\n\n', corps).strip()
    statut = 'preparatoire' if statut_page == 'draft' else 'publiee'
    entete = ['CONDITIONS DE COMMANDE — ALBUMS PERSONNELS', 'Run Coaching — Younous Jonas', f'Version : {version}', f'Date de la version : {date_version}']
    if statut == 'preparatoire':
        entete.append('VERSION PRÉPARATOIRE — NON PUBLIÉE — RÉSERVÉE À LA RECETTE SANS PAIEMENT RÉEL')
    texte = '\n'.join(entete) + '\n\n' + corps + '\n'
    if 'drive.google.com' in texte or 'mail.google.com' in texte:
        raise ValueError('Une source de travail privée se trouve dans la copie contractuelle')
    meta = {'version': version, 'dateVersion': date_version, 'statut': statut, 'page': '/conditions-bd.html', 'url': f'/conditions/{version}.txt', 'empreinteSha256': hashlib.sha256(texte.encode('utf-8')).hexdigest()}
    lignes = ',\n'.join('  ' + json.dumps(ligne, ensure_ascii=False) for ligne in texte.split('\n'))
    module = '// Généré par scripts/generer-conditions.py depuis conditions-bd.html. Ne pas modifier à la main.\n'
    module += 'const texte = [\n' + lignes + '\n].join("\\n");\n\n'
    module += 'export const CONDITIONS = Object.freeze({\n'
    module += ''.join('  ' + cle + ': ' + json.dumps(val, ensure_ascii=False) + ',\n' for cle, val in meta.items())
    module += '  texte,\n});\n'
    return {ROOT / 'netlify/functions/bd-lib/conditions.mjs': module, ROOT / meta['url'].lstrip('/'): texte}


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--check', action='store_true')
    args = cli.parse_args()
    artefacts = produire()
    for chemin, contenu in artefacts.items():
        if args.check:
            if not chemin.exists() or chemin.read_text(encoding='utf-8') != contenu:
                raise SystemExit('Copie contractuelle désynchronisée : ' + str(chemin.relative_to(ROOT)))
        else:
            # Une copie déjà figée ne change jamais sous le même identifiant.
            if chemin.suffix == '.txt' and chemin.exists() and chemin.read_text(encoding='utf-8') != contenu:
                raise SystemExit('Texte modifié : choisir une nouvelle version avant de générer')
    if not args.check:
        for chemin, contenu in artefacts.items():
            chemin.parent.mkdir(parents=True, exist_ok=True)
            chemin.write_text(contenu, encoding='utf-8')
    print('Copies contractuelles synchronisées : ' + str(len(artefacts)) + ' fichiers')
