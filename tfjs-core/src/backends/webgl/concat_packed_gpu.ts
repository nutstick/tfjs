/**
 * @license
 * Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as concat_util from '../../ops/concat_util';
import {getChannels} from '../packing_util';

import {GPGPUProgram} from './gpgpu_math';
import {getCoordsDataType} from './shader_compiler';

export class ConcatPackedProgram implements GPGPUProgram {
  variableNames: string[];
  usesPackedTextures = true;
  outputShape: number[] = [];
  userCode: string;

  constructor(shapes: number[][], axis: number) {
    this.outputShape = concat_util.computeOutShape(shapes, axis);
    const shape = this.outputShape;
    const rank = shape.length;
    const dtype = getCoordsDataType(rank);
    const coords = getChannels('coords', rank);
    const channels = ['x', 'y', 'z', 'w', 'u', 'v'].slice(0, rank);
    this.variableNames = shapes.map((_, i) => `T${i}`);

    const offsets: number[] = new Array(shapes.length - 1);
    offsets[0] = shapes[0][axis];
    for (let i = 1; i < offsets.length; i++) {
      offsets[i] = offsets[i - 1] + shapes[i][axis];
    }

    const channel = channels[axis];
    const lastChannels = channels.slice(-2);
    const allChannels = channels.join();

    let getValueSnippet = `if (${channel} < ${offsets[0]}) {
        return getChannel(
            getT0(${allChannels}), vec2(${lastChannels.join()}));
        }`;
    for (let i = 1; i < offsets.length; i++) {
      const shift = offsets[i - 1];
      getValueSnippet += `
        else if (${channel} == ${offsets[i - 1]}) {
          // ${channel} = ${channel} - ${shift};
          return getChannel(
            getT${i}(${shiftedChannels(channels, channel, shift)}),
            vec2(${shiftedChannels(lastChannels, channel, shift)}));
        }`;
    }
    const lastIndex = offsets.length;
    const shift = offsets[offsets.length - 1];
    getValueSnippet += `
        else {
          // ${channel} = ${channel} - ${shift};
          return getChannel(
            getT${lastIndex}(${shiftedChannels(channels, channel, shift)}),
            vec2(${shiftedChannels(lastChannels, channel, shift)}));
        }`;

    this.userCode = `
      float getValue(${channels.map(x => 'int ' + x)}) {
        ${getValueSnippet}
      }

      void main() {
        ${dtype} coords = getOutputCoords();
        vec4 result = vec4(getValue(${coords}), 0., 0., 0.);

        ${coords[rank - 1]} = ${coords[rank - 1]} + 1;
        if (${coords[rank - 1]} < ${shape[rank - 1]}) {
          result.g = getValue(${coords});
        }

        ${coords[rank - 2]} = ${coords[rank - 2]} + 1;
        if (${coords[rank - 2]} < ${shape[rank - 2]}) {
          result.a = getValue(${coords});
        }

        ${coords[rank - 1]} = ${coords[rank - 1]} - 1;
        if (${coords[rank - 2]} < ${shape[rank - 2]} &&
            ${coords[rank - 1]} < ${shape[rank - 1]}) {
          result.b = getValue(${coords});
        }
        setOutput(result);
      }
    `;

    // console.log(this.userCode);
  }
}

function shiftedChannels(channels: string[], channel: string, shift: number) {
  const channelIdx = channels.indexOf(channel);
  const res = channels.map((c, idx) => {
    if (idx === channelIdx) {
      return `${c} - ${shift}`;
    } else {
      return c;
    }
  });
  return res.join();
}
