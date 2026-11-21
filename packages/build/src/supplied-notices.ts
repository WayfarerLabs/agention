// The notice text the build supplies for one version of an npm package, in
// blocks its notice carries before any license file the build finds: first
// those quoted verbatim from the package's own files, which a test finds in
// the installed copy, then any Agention writes.
export interface SuppliedNotice {
  quoted: readonly string[];
  ours?: readonly string[];
}

// suppliedNotices holds the notice text the build supplies for a version of
// an npm package because the package's own files do not give it to the
// build. The text names one version's files, so a new version needs its own,
// and the build fails for a package that needs some and has none
// (suppliedNotice in bundle.ts). Two kinds of package need it:
//
// - One under the Eclipse Public License 2.0. Its section 3.1(a) asks that the
//   program come with a statement that its source code is available under the
//   license and how to obtain it, and its section 3.3 that no copyright notice
//   in it be removed from a copy, which minification does. A script that
//   includes one opens with this text too.
// - One whose license text the build cannot find, either in no license file at
//   all or in one the Vite build's notices do not read.
export const suppliedNotices: Readonly<Record<string, SuppliedNotice>> = {
  // elkjs is under EPL-2.0 OR GPL-3.0-or-later, and Agention takes it under the
  // EPL-2.0. Its copyright notices are the headers of lib/elk.bundled.js, the
  // file Mermaid includes; its LICENSE.md has none. It is compiled from the
  // Java sources of the Eclipse Layout Kernel, so its source is the elkjs build
  // and the ELK release it builds from, which its GitHub release names: elkjs
  // 0.12.1 is "Based on ELK 0.12.1".
  "elkjs@0.12.1": {
    quoted: [
      "Copyright (c) 2017 Kiel University and others.",
      "Copyright (c) 2021 Kiel University and others.",
    ],
    ours: [
      "Agention distributes elkjs under the EPL-2.0. Its source code is available under the " +
        "EPL-2.0: the elkjs build at https://github.com/kieler/elkjs/tree/0.12.1, and the " +
        "Eclipse Layout Kernel it compiles from Java at " +
        "https://github.com/eclipse-elk/elk/tree/v0.12.1.",
    ],
  },
  // fastdom has no license file: this is the License section of its README.md.
  "fastdom@1.0.12": {
    quoted: [
      "(The MIT License)",
      "Copyright (c) 2016 Wilson Page <wilsonpage@me.com>",
      "Permission is hereby granted, free of charge, to any person obtaining a copy of this " +
        "software and associated documentation files (the 'Software'), to deal in the Software " +
        "without restriction, including without limitation the rights to use, copy, modify, " +
        "merge, publish, distribute, sublicense, and/or sell copies of the Software, and to " +
        "permit persons to whom the Software is furnished to do so, subject to the following " +
        "conditions:",
      "The above copyright notice and this permission notice shall be included in all copies " +
        "or substantial portions of the Software.",
      "THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, " +
        "INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A " +
        "PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT " +
        "HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF " +
        "CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE " +
        "OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
    ],
  },
  // @panzoom/panzoom's license file is MIT-License.txt, which the Vite build's
  // notices do not read: this is that file.
  "@panzoom/panzoom@4.6.2": {
    quoted: [
      "Copyright 2016-2019 Timmy Willison",
      "Permission is hereby granted, free of charge, to any person obtaining\n" +
        "a copy of this software and associated documentation files (the\n" +
        '"Software"), to deal in the Software without restriction, including\n' +
        "without limitation the rights to use, copy, modify, merge, publish,\n" +
        "distribute, sublicense, and/or sell copies of the Software, and to\n" +
        "permit persons to whom the Software is furnished to do so, subject to\n" +
        "the following conditions:",
      "The above copyright notice and this permission notice shall be\n" +
        "included in all copies or substantial portions of the Software.",
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,\n' +
        "EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF\n" +
        "MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND\n" +
        "NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE\n" +
        "LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION\n" +
        "OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION\n" +
        "WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
    ],
  },
};
