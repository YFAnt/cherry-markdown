/**
 * Copyright (C) 2021 Tencent.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import ParagraphBase from '@/core/ParagraphBase';
import { getTableRule } from '@/utils/regexp';

const TABLE_LOOSE = 'loose';
const TABLE_STRICT = 'strict';

export default class Table extends ParagraphBase {
  static HOOK_NAME = 'table';

  constructor({ externals, config }) {
    super({ needCache: true });
    const {
      enableChart,
      selfClosing,
      chartRenderEngine: ChartRenderEngine,
      externals: requiredPackages,
      chartEngineOptions = {},
    } = config;
    this.chartRenderEngine = null;
    this.selfClosing = selfClosing;
    if (enableChart === true) {
      try {
        this.chartRenderEngine = new ChartRenderEngine({
          // 注入需要的第三方包
          ...(externals &&
            requiredPackages instanceof Array &&
            requiredPackages.reduce((acc, pkg) => {
              delete chartEngineOptions[pkg]; // 过滤第三方包选项
              return { ...acc, [pkg]: externals[pkg] };
            }, {})),
          renderer: 'svg',
          width: 500,
          height: 300,
          ...chartEngineOptions,
        });
      } catch (error) {
        console.warn(error);
      }
    }
  }

  // 保持每列长度一致
  $extendColumns(row, colCount) {
    const delta = colCount - row.length;
    if (delta < 1) {
      return row;
    }
    return row.concat('&nbsp;|'.repeat(delta).split('|', delta));
  }

  $parseChartOptions(cell) {
    // 初始化失败
    if (!this.chartRenderEngine) {
      return null;
    }
    const CHART_REGEX = /^[ ]*:(\w+):(?:[ ]*{(.*?)}[ ]*)?$/;
    if (!CHART_REGEX.test(cell)) {
      return null;
    }
    const match = cell.match(CHART_REGEX);
    const [, chartType, axisOptions] = match;
    const DEFAULT_AXIS_OPTIONS = ['x', 'y'];
    return {
      type: chartType,
      options: axisOptions ? axisOptions.split(/\s*,\s*/) : DEFAULT_AXIS_OPTIONS,
    };
  }

  $parseColumnAlignRules(row) {
    const COLUMN_ALIGN_MAP = { L: 'left', R: 'right', C: 'center' };
    const COLUMN_ALIGN_CACHE_SIGN = ['U', 'L', 'R', 'C']; // U for undefined
    const textAlignRules = row.map((rule) => {
      const $rule = rule.trim();
      let index = 0;
      if (/^:/.test($rule)) {
        index += 1;
      }
      if (/:$/.test($rule)) {
        index += 2;
      }
      return COLUMN_ALIGN_CACHE_SIGN[index];
    });
    return { textAlignRules, COLUMN_ALIGN_MAP };
  }

  $parseTable(lines, sentenceMakeFunc, dataLines) {
    let maxCol = 0;
    const rows = lines.map((line, index) => {
      const cols = line.replace(/\\\|/g, '~CS').split('|');
      if (cols[0] === '') {
        cols.shift();
      }
      if (cols[cols.length - 1] === '') {
        cols.pop();
      }
      // 文本对齐相关列，不作为最多列数的参考依据
      index !== 1 && (maxCol = Math.max(maxCol, cols.length));
      return cols;
    });
    const { textAlignRules, COLUMN_ALIGN_MAP } = this.$parseColumnAlignRules(rows[1]);
    const tableObject = {
      header: [],
      rows: [],
      colLength: maxCol,
      rowLength: rows.length - 2, // 去除表头和控制行
    };
    const chartOptions = this.$parseChartOptions(rows[0][0]);
    const chartOptionsSign = this.$engine.hash(rows[0][0]);
    // 如果需要生成图表，
    if (chartOptions) {
      rows[0][0] = '';
    }
    /**
     * ~CTHD: <thead>
     * ~CTHD$: </thead>
     * ~CTBD: <tbody>
     * ~CTBD$: </tbody>
     * ~CTR: <tr>
     * ~CTR$: </tr>
     * ~CTH(L|R|C|U): <th>
     * ~CTH$: </th>
     * ~CTD(L|R|C|U): <td>
     * ~CTD$: </td>
     * ~CTD(L|R|C|U)#n: <td colspan="n">  // 支持右合并
     * ~CTD(L|R|C|U)@n: <td rowspan="n">  // 支持上合并
     * ~CTD(L|R|C|U)#n@m: <td colspan="n" rowspan="m">  // 支持同时合并
     */

    // 处理表头的右合并
    const processedHeaderCells = this.$processRightMerge(rows[0], maxCol);
    const tableHeader = processedHeaderCells
      .map((cellInfo, col) => {
        const { cell, colspan } = cellInfo;
        tableObject.header.push(cell.replace(/~CS/g, '\\|'));
        const { html: cellHtml } = sentenceMakeFunc(cell.replace(/~CS/g, '\\|').trim());
        // 前后补一个空格，否则自动链接会将缓存的内容全部收入链接内部
        const colspanAttr = colspan > 1 ? `#${colspan}` : '';
        return `~CTH${textAlignRules[col] || 'U'}${colspanAttr} ${cellHtml} ~CTH$`;
      })
      .join('');

    // 处理数据行（跳过表头和分隔行）
    const dataRows = rows.slice(2);
    // 计算垂直合并信息
    const verticalMergeInfo = this.$processRowSpan(dataRows);

    const tableRows = rows
      .reduce((table, row, line) => {
        // 跳过表头和分隔行
        if (line <= 1) {
          return table;
        }

        const rowIndex = line - 2; // 当前行在数据行中的索引
        tableObject.rows[rowIndex] = [];

        // 处理当前行的水平合并
        const horizontalMergedCells = this.$processRightMerge(row, maxCol);

        // 合并水平和垂直合并信息
        const mergedCells = horizontalMergedCells.map((item, colIndex) => {
          return {
            ...item,
            rowspan: verticalMergeInfo[rowIndex][colIndex].rowspan,
            isSkipped: verticalMergeInfo[rowIndex][colIndex].isSkipped,
          };
        });

        // 生成单元格HTML标记
        const renderedCells = mergedCells.map((cellInfo, colIndex) => {
          const { cell, colspan, rowspan, isSkipped } = cellInfo;

          // 如果单元格被标记为需要跳过（被垂直合并），则不渲染
          if (isSkipped) {
            return '';
          }

          tableObject.rows[rowIndex].push(cell.replace(/~CS/g, '\\|'));
          const { html: cellHtml } = sentenceMakeFunc(cell.replace(/~CS/g, '\\|').trim());

          // 处理合并属性
          const colspanAttr = colspan > 1 ? `#${colspan}` : '';
          const rowspanAttr = rowspan > 1 ? `@${rowspan}` : '';

          return `~CTD${textAlignRules[colIndex] || 'U'}${colspanAttr}${rowspanAttr} ${cellHtml} ~CTD$`;
        });

        // 过滤掉空字符串（被跳过的单元格）
        const filteredCells = renderedCells.filter((cell) => cell !== '');

        // 只有当有单元格需要渲染时，才添加这一行
        if (filteredCells.length > 0) {
          table.push(`~CTR${filteredCells.join('')}~CTR$`);
        }

        return table;
      }, [])
      .join('');

    // 渲染表格
    const tableResult = this.$renderTable(COLUMN_ALIGN_MAP, tableHeader, tableRows, dataLines);

    // 如果没有图表选项，直接返回表格结果
    if (!chartOptions) {
      return tableResult;
    }

    // 处理图表渲染
    const chart = this.chartRenderEngine.render(chartOptions.type, chartOptions.options, tableObject);
    const chartHtml = `<figure class="cherry-table-figure">${chart}</figure>`;
    const newSign = `${tableResult.sign}${chartOptionsSign}`;

    return {
      html: tableResult.html
        .replace(/(^<div .*?>)/, `$1${chartHtml}`)
        .replace(/(^<div .*? data-sign=")[^"]+?"/, `$1${newSign}"`),
      sign: newSign,
    };
  }

  /**
   * 处理表格行中的水平合并标记（右合并）
   * @param {Array} row 表格行数据
   * @param {Number} maxCol 最大列数
   * @returns {Array} 处理后的单元格信息，包含cell和colspan属性
   */
  $processRightMerge(row, maxCol) {
    const extendedRow = this.$extendColumns(row, maxCol);
    const result = [];
    let skipCount = 0;

    // 处理表格行的右合并
    for (let i = 0; i < extendedRow.length; i++) {
      // 跳过已经被合并的单元格
      if (skipCount > 0) {
        skipCount = skipCount - 1;
        continue;
      }

      const cell = extendedRow[i];
      let colspan = 1;

      // 检查单元格是否包含右合并标记 '>'
      // 如果单元格内容仅为 '>' 或 '&gt;'，则与前一个单元格合并
      if (cell.trim() === '>' || cell.trim() === '&gt;') {
        // 这是一个需要被合并的单元格，跳过它
        continue;
      }

      // 检查后续单元格是否需要被合并
      let j = i + 1;
      while (j < extendedRow.length && (extendedRow[j].trim() === '>' || extendedRow[j].trim() === '&gt;')) {
        colspan = colspan + 1;
        j = j + 1;
      }

      skipCount = colspan - 1;
      result.push({ cell, colspan });
    }

    return result;
  }

  /**
   * 处理表格中的垂直合并标记（向上合并）
   * @param {Array} rows 表格数据行（不含表头和分隔行）
   * @returns {Array} 垂直合并信息，包含每个单元格的rowspan和isSkipped属性
   */
  $processRowSpan(rows) {
    // 结果数组，存储每个单元格的rowspan信息
    const result = [];

    // 如果没有行数据，直接返回空结果
    if (!rows || rows.length === 0) {
      return result;
    }

    // 获取列数（假设第一行的列数为标准）
    const colCount = rows[0].length;

    // 初始化结果数组
    for (let i = 0; i < rows.length; i++) {
      result[i] = [];
      for (let j = 0; j < colCount; j++) {
        result[i][j] = { rowspan: 1, isSkipped: false };
      }
    }

    // 遍历每一列
    for (let col = 0; col < colCount; col++) {
      let currentRowspan = 1;
      let startRowIndex = 0;

      // 从第二行开始检查
      for (let row = 1; row < rows.length; row++) {
        // 确保行有足够的列
        if (rows[row] && col < rows[row].length) {
          const cell = rows[row][col];

          // 检查单元格是否包含向上合并标记 '^'
          if (cell && (cell.trim() === '^' || cell.trim() === '&Hat;')) {
            // 这是一个需要被合并的单元格
            currentRowspan = currentRowspan + 1;

            // 标记这个单元格为需要跳过的单元格
            result[row][col].isSkipped = true;
          } else {
            // 如果当前单元格不是合并标记，且之前有累积的rowspan
            if (currentRowspan > 1) {
              // 设置起始单元格的rowspan
              result[startRowIndex][col].rowspan = currentRowspan;

              // 重置计数器
              currentRowspan = 1;
            }

            // 更新起始行索引
            startRowIndex = row;
          }
        }
      }

      // 处理最后一组合并
      if (currentRowspan > 1) {
        result[startRowIndex][col].rowspan = currentRowspan;
      }
    }

    return result;
  }

  /**
   * 如果table.head是空的，就不渲染<thead>了
   * @param {String} str
   * @returns {Boolean}
   */
  $testHeadEmpty(str) {
    const test = str
      .replace(/&nbsp;/g, '')
      .replace(/\s/g, '')
      .replace(/(~CTH\$|~CTHU|~CTHL|~CTHR|~CTHC)/g, '');
    return test?.length > 0;
  }

  $renderTable(COLUMN_ALIGN_MAP, tableHeader, tableRows, dataLines) {
    const cacheSrc = this.$testHeadEmpty(tableHeader)
      ? `~CTHD${tableHeader}~CTHD$~CTBD${tableRows}~CTBD$`
      : `~CTBD${tableRows}~CTBD$`;
    const html = cacheSrc;
    const sign = this.$engine.hash(html);
    const renderHtml = html
      .replace(/~CTHD\$/g, '</thead>')
      .replace(/~CTHD/g, '<thead>')
      .replace(/~CTBD\$/g, '</tbody>')
      .replace(/~CTBD/g, '<tbody>')
      .replace(/~CTR\$/g, '</tr>')
      .replace(/~CTR/g, '<tr>')
      .replace(/[ ]?~CTH\$/g, '</th>')
      .replace(/[ ]?~CTD\$/g, '</td>') // 在这里将加上的空格还原回来
      .replace(/~CT(D|H)(L|R|C|U)(#\d+)?(@\d+)?[ ]?/g, (match, type, align, colspan, rowspan) => {
        let tag = `<t${type}`;
        if (align === 'U') {
          tag += '';
        } else {
          tag += ` align="${COLUMN_ALIGN_MAP[align]}"`;
        }
        // 处理colspan属性
        if (colspan) {
          const colspanValue = colspan.substring(1); // 去掉#号
          tag += ` colspan="${colspanValue}"`;
        }
        // 处理rowspan属性
        if (rowspan) {
          const rowspanValue = rowspan.substring(1); // 去掉@号
          tag += ` rowspan="${rowspanValue}"`;
        }
        tag += '>';
        return tag;
      })
      .replace(/\\\|/g, '|'); // escape \|
    return {
      html: `<div class="cherry-table-container" data-sign="${sign}${dataLines}" data-lines="${dataLines}">
        <table class="cherry-table">${renderHtml}</table></div>`,
      sign,
    };
  }

  makeHtml(str, sentenceMakeFunc) {
    let $str = str;
    if (this.$engine.$cherry.options.engine.global.flowSessionContext || this.selfClosing) {
      if (/(^|^[^|][^\n]*\n|\n\n|\n[^|][^\n]*\n)\s*\|[^\n]+\n{0,1}[|:-\s]*\n*$/.test($str)) {
        $str = `${$str.replace(/\n[|:-\s]*\n*$/, '')}\n|-|`;
      }
    }
    // strict fenced mode
    if (this.test($str, TABLE_STRICT)) {
      $str = $str.replace(this.RULE[TABLE_STRICT].reg, (match, leading) => {
        const dataLines = this.getLineCount(match, leading);
        // 必须先trim，否则分割出来的结果不对
        // 将fenced mode转换为loose mode
        const lines = match
          .trim()
          .split(/\n/)
          .map((line) => String(line).trim());
        const { html: table, sign } = this.$parseTable(lines, sentenceMakeFunc, dataLines);
        return this.getCacheWithSpace(this.pushCache(table, sign, dataLines), match);
      });
    }
    // loose mode
    if (this.test($str, TABLE_LOOSE)) {
      // console.log(TABLE_LOOSE);
      $str = $str.replace(this.RULE[TABLE_LOOSE].reg, (match, leading) => {
        const dataLines = this.getLineCount(match, leading);
        // 必须先trim，否则分割出来的结果不对
        const lines = match
          .trim()
          .split(/\n/)
          .map((line) => String(line).trim());
        const { html: table, sign } = this.$parseTable(lines, sentenceMakeFunc, dataLines);
        return this.getCacheWithSpace(this.pushCache(table, sign, dataLines), match);
      });
    }
    return $str;
  }

  test(str, flavor) {
    return this.RULE[flavor].reg && this.RULE[flavor].reg.test(str);
  }

  /**
   * TODO: fix type errors
   * @returns
   */
  rule() {
    return /** @type {any} */ (getTableRule());
  }
}
