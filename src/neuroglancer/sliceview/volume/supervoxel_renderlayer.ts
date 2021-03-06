/**
 * @license
 * Copyright 2019 The Neuroglancer Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {GPUHashTable, HashSetShaderManager} from 'neuroglancer/gpu_hash/shader';
import {registerRedrawWhenSegmentationDisplayStateChanged} from 'neuroglancer/segmentation_display_state/frontend';
import {SliceView} from 'neuroglancer/sliceview/frontend';
import {MultiscaleVolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {RenderLayer} from 'neuroglancer/sliceview/volume/renderlayer';
import {SliceViewSegmentationDisplayState} from 'neuroglancer/sliceview/volume/segmentation_renderlayer';
import {TrackableBoolean} from 'neuroglancer/trackable_boolean';
import {TrackableRGB} from 'neuroglancer/util/color';
import {ShaderBuilder, ShaderProgram} from 'neuroglancer/webgl/shader';


interface SliceViewSupervoxelDisplayState extends SliceViewSegmentationDisplayState {
  supervoxelColor: TrackableRGB;
  isActive: TrackableBoolean;
  performingMulticut: TrackableBoolean;
}

export class SupervoxelRenderLayer extends RenderLayer {
  private hashTableManager = new HashSetShaderManager('visibleSegments2D');
  private gpuHashTable = GPUHashTable.get(this.gl, this.displayState.visibleSegments2D!.hashTable);

  constructor(
      multiscaleSource: MultiscaleVolumeChunkSource,
      public displayState: SliceViewSupervoxelDisplayState) {
    super(multiscaleSource, {
      sourceOptions: displayState.volumeSourceOptions,
      transform: displayState.transform,
      renderScaleHistogram: displayState.renderScaleHistogram,
      renderScaleTarget: displayState.renderScaleTarget,
    });
    registerRedrawWhenSegmentationDisplayStateChanged(displayState, this);
    this.registerDisposer(displayState.isActive.changed.add(() => {
      this.redrawNeeded.dispatch();
    }));
  }

  getShaderKey() {
    return 'sliceview.SupervoxelRenderLayer';
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    this.hashTableManager.defineShader(builder);
    builder.addFragmentCode(`
  uint64_t getUint64DataValue() {
    return toUint64(getDataValue());
  }
  `);
    builder.addFragmentCode(`
  uint64_t getMappedObjectId() {
    return getUint64DataValue();
  }
  `);
    builder.addUniform('highp float', 'uSupervoxelRedValue');
    builder.addUniform('highp float', 'uSupervoxelGreenValue');
    builder.addUniform('highp float', 'uSupervoxelBlueValue');
    builder.addUniform('highp uvec2', 'uRawSelectedSegment');
    builder.addUniform('highp uint', 'uIsActive');
    builder.addUniform('highp uint', 'uPerformingMulticut');
    let fragmentMain = `
    uint64_t value = getMappedObjectId();
    uint64_t rawValue = getUint64DataValue();
  `;
    if (this.displayState.hideSegmentZero.value) {
      fragmentMain += `
    if ((value.value[0] == 0u && value.value[1] == 0u) || uPerformingMulticut == 0u) {
      emit(vec4(0, 0, 0, 0));
      return;
    }
  `;
    }
    fragmentMain += `
    bool has = ${this.hashTableManager.hasFunctionName}(value);
    `;
    fragmentMain += `
    if (uIsActive == 1u && uRawSelectedSegment == rawValue.value) {
      emit(vec4(uSupervoxelRedValue, uSupervoxelGreenValue, uSupervoxelBlueValue, 0.3));
    } else if (has) {
      emit(vec4(uSupervoxelRedValue, uSupervoxelGreenValue, uSupervoxelBlueValue, 0.6));
    }
    `;
    builder.setFragmentMain(fragmentMain);
  }

  beginSlice(sliceView: SliceView) {
    let shader = super.beginSlice(sliceView);
    if (shader === undefined) {
      return undefined;
    }
    const gl = this.gl;

    const {displayState} = this;
    const {segmentSelectionState} = displayState;
    let rawSelectedSegmentLow = 0, rawSelectedSegmentHigh = 0;
    if (segmentSelectionState.hasSelectedSegment) {
      let rawSeg = segmentSelectionState.rawSelectedSegment;
      rawSelectedSegmentLow = rawSeg.low;
      rawSelectedSegmentHigh = rawSeg.high;
    }
    gl.uniform1ui(shader.uniform('uIsActive'), displayState.isActive.value ? 1 : 0);
    gl.uniform1ui(
        shader.uniform('uPerformingMulticut'), displayState.performingMulticut.value ? 1 : 0);
    gl.uniform2ui(
        shader.uniform('uRawSelectedSegment'), rawSelectedSegmentLow, rawSelectedSegmentHigh);
    gl.uniform1f(shader.uniform('uSupervoxelRedValue'), displayState.supervoxelColor.value[0]);
    gl.uniform1f(shader.uniform('uSupervoxelGreenValue'), displayState.supervoxelColor.value[1]);
    gl.uniform1f(shader.uniform('uSupervoxelBlueValue'), displayState.supervoxelColor.value[2]);
    this.hashTableManager.enable(gl, shader, this.gpuHashTable);
    return shader;
  }

  endSlice(shader: ShaderProgram) {
    let {gl} = this;
    this.hashTableManager.disable(gl, shader);
    super.endSlice(shader);
  }
}
